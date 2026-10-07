param(
    [Parameter(Mandatory)][string]$Binding,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$BindingSha256,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$entryClock = [Diagnostics.Stopwatch]::StartNew()
if (-not $IsWindows -or [IntPtr]::Size -ne 8) { throw 'Windows x64 controller required' }
# Producer737 qualification does not qualify this equipment or grant entry.
$producerQualification = [pscustomobject]@{ status = 'QUALIFIED'; cases = 737 }
if ($producerQualification.status -cne 'QUALIFIED' -or $null -eq $producerQualification.cases) {
    throw 'Actual producer qualification is not frozen'
}
$expectedProducerEvidence = @'
{
  "qualificationReceipt": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/ea592-original737-success-root-v2/review.json",
    "bytes": 7790,
    "sha256": "e3a01453b7bc7dfd37bf7d7f164b224a00c0d1a9bf0ea0a64db9367051fae50d"
  },
  "producerRootReview": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/producer-and-short47-success-root-v83/review.json",
    "bytes": 5065,
    "sha256": "4e016fb886ce5f0bd5cdcd07fc8edc4c6531a2b68eeef98b523257441e1af16d"
  },
  "originalProducerResult": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/result.json",
    "bytes": 25090,
    "sha256": "acfe094189a22d6de137ef3e4df8bc1ed389005c33e097bc2da9859de845e7fa"
  },
  "buildReceipt": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/ordinary-production-build-original-result.json",
    "bytes": 13537,
    "sha256": "62b2da6fa03b91b6d836eba0af07fdfa9e09101180e78589465a50d2349a203d"
  },
  "packReceipt": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/five-actual-packages-original-result.json",
    "bytes": 5218,
    "sha256": "8f9ed9ecaae871fd1ddd3541891f14c5706720b7f1e4a37c6d8c2bb9ffbdecae"
  },
  "archive": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/flujo-ai-3.46.3.tgz",
    "bytes": 10339465,
    "sha256": "73b5f9f370d41a36bf450050fa3e7ac2817cccb03f861d4ed1e4f15ceb9f1554"
  },
  "graphReceipt": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/after-complete-own91930-graph.json",
    "bytes": 27410813,
    "sha256": "bc370cf7897f54801304c460cd116539ab1721499e995cb8f98a77249d7e529b"
  },
  "artifactJoin": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/five-original-packages-artifact-join.json",
    "bytes": 5769,
    "sha256": "e738f4fd8e0dcb9a593655341d63bd0a87ff4c9fe4453a0fc2afe97795817355"
  },
  "generatedOutputReceipt": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/after-complete-generated-output-pins.json",
    "bytes": 708941,
    "sha256": "ad84ba293d87eb3850ffa8cc01316ef88ae13466e00987f5eb9c4edfe2e4233c"
  },
  "originalEvidence": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/completed-original-nrec2-producer-output-pins-v1.json",
    "bytes": 252625,
    "sha256": "9bbde6cfe889e896257fcdc06df68afcecb945d1396d8e86c9b3dc886264750d"
  },
  "graphRootReview": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/ea592-monitor-install-success-root-v80/review.json",
    "bytes": 3191,
    "sha256": "ccbaa93f8231a6c83a89e9237b2837cf1085b6dda02e425a77e1a56d87aea6f6"
  }
}
'@ | ConvertFrom-Json
$expectedPackageArchives = @'
[
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/flujo-ai-3.46.3.tgz",
    "bytes": 10339465,
    "sha256": "73b5f9f370d41a36bf450050fa3e7ac2817cccb03f861d4ed1e4f15ceb9f1554"
  },
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/mario.andreschak-mcp-filesystem-3.46.3.tgz",
    "bytes": 56613,
    "sha256": "918435f4274c5d84ffafc07e1c0b5bcf662af768cbe27319b3b78a1679e50a21"
  },
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/mario.andreschak-mcp-bash-3.46.3.tgz",
    "bytes": 57885,
    "sha256": "a8cb28f8d9734cbed4764a8ec0388f80f1ea77999b7b045c56e9c378c1f44755"
  },
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/mario.andreschak-mcp-browser-3.46.3.tgz",
    "bytes": 95401,
    "sha256": "1ed59e83050e60b7f77ef92d6adf4f897a382202623cc0af9213310cdadc95fa"
  },
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/missing-source-nrec2-ordinary-producer-20261007-v1/original-nrec2-producer-entry-v1/artifacts/mario.andreschak-mcp-flujo-3.46.3.tgz",
    "bytes": 11678,
    "sha256": "40c9d29272aaa98363770cccdb9f305134cb76bb94fdc3a0f7b339bd88f6caa6"
  }
]
'@ | ConvertFrom-Json
function Check-Window {
    if ($entryClock.ElapsedMilliseconds -ge 60000) { throw 'Controller preentry deadline exceeded' }
}
function Check-Pin($pin) {
    Check-Window
    if (-not [IO.Path]::IsPathFullyQualified($pin.path)) { throw 'Absolute pin required' }
    $item = [IO.FileInfo]::new($pin.path)
    if (($item.Attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -or $item.Length -ne $pin.bytes) { throw 'Pin shape/bytes changed' }
    $stream = [IO.File]::OpenRead($pin.path)
    try { $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
    finally { $stream.Dispose() }
    if ($digest -cne $pin.sha256) { throw 'Pin digest changed' }
    Check-Window
}
function Check-Table([string]$root, $files) {
    if (-not [IO.Path]::IsPathFullyQualified($root) -or $files.Count -lt 1 -or $files.Count -gt 100000) { throw 'Root/file census refused' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$bytes = 0
    $canonicalRoot = [IO.Path]::GetFullPath($root)
    foreach ($file in $files) {
        if ($file.path.Length -gt 1024 -or $file.path -match '[\\:\x00-\x1f]' -or $file.path.StartsWith('/')) { throw 'Invalid relative path' }
        $parts = $file.path.Split('/')
        foreach ($part in $parts) {
            if ($part -eq '' -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$') { throw 'Path alias/escape' }
        }
        if (-not $seen.Add($file.path)) { throw 'Duplicate path' }
        if ($file.bytes -lt 0 -or $file.bytes -gt 268435456 -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid file pin' }
        $bytes += $file.bytes; if ($bytes -gt 34359738368) { throw 'Table byte budget exceeded' }
        $current = $canonicalRoot
        foreach ($part in @('') + $parts) {
            if ($part) { $current = [IO.Path]::Combine($current,$part) }
            if ([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) { throw 'Junction/symlink refused' }
        }
        Check-Pin ([pscustomobject]@{path=$current;bytes=$file.bytes;sha256=$file.sha256})
    }
}
function Check-Reference($actual, $expected) {
    if ($actual.path -cne $expected.path -or $actual.bytes -ne $expected.bytes -or $actual.sha256 -cne $expected.sha256) {
        throw 'Actual producer receipt/archive identity changed'
    }
}
if (-not [IO.Path]::IsPathFullyQualified($Binding) -or -not [IO.Path]::IsPathFullyQualified($OutputDirectory)) { throw 'Absolute paths required' }
$bindingItem = Get-Item -LiteralPath $Binding
if ($bindingItem.Length -gt 33554432 -or ($bindingItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Binding shape/budget refused' }
if ((Get-FileHash -LiteralPath $Binding).Hash.ToLowerInvariant() -cne $BindingSha256) { throw 'Binding digest changed' }
$admission = Get-Content -Raw -LiteralPath $Binding | ConvertFrom-Json
if ($admission.schemaVersion -ne 1 -or $admission.profile -cne 'owned-windows-job-local-compiled-recovery') { throw 'Wrong profile' }
if ($admission.producer.identity.head -cne 'ea592d62075bafbb70ddbe1eb76479f1572aff81' -or $admission.producer.identity.tree -cne 'eca03ce7627ba31f155a37da89deaf3a99ad2835') { throw 'ExactEA592 producer required' }
if ($admission.producer.qualification.status -cne $producerQualification.status -or $admission.producer.qualification.cases -ne $producerQualification.cases) { throw 'Exact producer qualification not admitted' }
foreach ($property in $expectedProducerEvidence.PSObject.Properties) {
    $actualReference = if ($property.Name -ceq 'qualificationReceipt') { $admission.producer.qualification.receipt } else { $admission.producer.($property.Name) }
    Check-Reference $actualReference $property.Value
}
if ($admission.producer.packageArchives.Count -ne $expectedPackageArchives.Count) { throw 'Five actual archive pins required' }
for ($archiveIndex = 0; $archiveIndex -lt $expectedPackageArchives.Count; $archiveIndex++) {
    Check-Reference $admission.producer.packageArchives[$archiveIndex] $expectedPackageArchives[$archiveIndex]
}
if ($admission.equipment.qualification.status -cne 'QUALIFIED' -or $admission.equipment.qualification.nodeCases -ne 47 -or $admission.equipment.qualification.nativeCases -ne 4) { throw 'Separate47 fixture and4 native-control qualification held' }
if ($admission.controller.status -cne 'QUALIFIED' -or $admission.controller.profile -cne 'atomic-job-list-before-resume-windows-job') { throw 'Native controller qualification held' }
if ($admission.lease.maximumEntries -ne 1 -or $admission.lease.driverMs -ne 1860000 -or $admission.lease.finalizationMs -ne 30000 -or [DateTime]::UtcNow -ge $admission.lease.expiresAtUtc.ToUniversalTime()) { throw 'Lease missing/expired or widened' }
if ([IO.Path]::GetFullPath($OutputDirectory) -cne $admission.controller.outputDirectory) { throw 'Output namespace changed' }
$equipmentRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ($equipmentRoot -cne $admission.equipment.root) { throw 'Equipment root changed' }
Check-Table $equipmentRoot $admission.equipment.files
Check-Table $admission.applicationRoot $admission.payload.files
foreach ($reference in @($expectedProducerEvidence.PSObject.Properties.Value) + @($expectedPackageArchives) + @($admission.equipment.graphReceipt,$admission.equipment.qualification.receipt,$admission.controller.qualificationReceipt,$admission.lease.grant)) { Check-Pin $reference }
Check-Pin $admission.node
if ($admission.node.sha256 -cne '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e') { throw 'Wrong Node executable' }
foreach ($file in @('scripts/recovery-controller/WindowsRecoveryJob.cs','scripts/recovery-controller/Invoke-WorkerRecovery.ps1',
    'scripts/smoke-cloud-worker.mjs','scripts/worker-recovery-binding.mjs','scripts/worker-recovery-acceptance.mjs',
    'scripts/worker-recovery-runtime.mjs','scripts/worker-recovery-acceptance.test.mjs','scripts/worker-recovery-runtime.test.mjs',
    'scripts/worker-recovery-binding.test.mjs','scripts/recovery-controller/Test-WindowsRecoveryJob.ps1',
    'scripts/recovery-controller/native-job-fixture.mjs','scripts/mcp-smoke-cleanup.mjs','scripts/healthcheck.mjs',
    'scripts/persona-browser-acceptance/next-process.cjs')) {
    if (-not ($admission.equipment.files | Where-Object { $_.path -ceq $file })) { throw 'Controller/runtime Source pin missing' }
}
foreach ($name in @('.env','.env.local','.env.production','.env.production.local')) {
    if (Test-Path -LiteralPath (Join-Path $admission.applicationRoot $name)) { throw 'Application dotenv refused' }
}
Check-Window
# New directory is the one-shot entry marker. Preserve even preentry/native failure.
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'home'),(Join-Path $OutputDirectory 'temp') | Out-Null
$environment = [Collections.Generic.SortedDictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('SystemRoot','WINDIR','COMSPEC','PATHEXT','SystemDrive','ProgramFiles','ProgramFiles(x86)')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $environment.Add($name,$value) }
}
$environment.Add('PATH',(Split-Path -Parent $admission.node.path) + ';' + (Join-Path $env:SystemRoot 'System32') + ';' + $env:SystemRoot)
foreach ($name in @('HOME','USERPROFILE')) { $environment.Add($name,(Join-Path $OutputDirectory 'home')) }
foreach ($name in @('TEMP','TMP','TMPDIR')) { $environment.Add($name,(Join-Path $OutputDirectory 'temp')) }
$environment.Add('NEXT_TELEMETRY_DISABLED','1')
$environment.Add('FLUJO_BUILD_REVISION',$admission.producer.identity.head)
$environment.Add('FLUJO_RECOVERY_NODE_SHA256',$admission.node.sha256)
$environment.Add('FLUJO_RECOVERY_JOB_BOUND',$BindingSha256)
$environmentText = (($environment.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value }) -join [char]0) + [char]0 + [char]0
$entry = [ordered]@{bindingSha256=$BindingSha256;producer=$admission.producer.identity;equipmentHead=$admission.equipment.head;node=$admission.node;environment=$environment;lease=$admission.lease;enteredAtUtc=[DateTime]::UtcNow.ToString('o');runtime='NOT_STARTED'}
$entryJson = $entry | ConvertTo-Json -Depth 10
$entryStream = [IO.File]::Open((Join-Path $OutputDirectory 'controller-entry.json'),[IO.FileMode]::CreateNew)
try { $entryBytes=[Text.Encoding]::UTF8.GetBytes($entryJson);$entryStream.Write($entryBytes,0,$entryBytes.Length);$entryStream.Flush($true) } finally { $entryStream.Dispose() }
Add-Type -Path (Join-Path $PSScriptRoot 'WindowsRecoveryJob.cs')
Check-Window
$arguments = @((Join-Path $equipmentRoot 'scripts/smoke-cloud-worker.mjs'),'--production','--worker-recovery','--application',$admission.applicationRoot,'--binding',$Binding,'--binding-sha256',$BindingSha256)
Check-Pin $admission.node
Check-Window
if ([DateTime]::UtcNow -ge $admission.lease.expiresAtUtc.ToUniversalTime()) { throw 'Lease expired before original entry' }
$receipt = [WindowsRecoveryJob]::Run($admission.node.path,$arguments,$equipmentRoot,$environmentText,$OutputDirectory)
$terminal = [ordered]@{bindingSha256=$BindingSha256;producer=$admission.producer.identity;equipmentHead=$admission.equipment.head;originalOwnedJob=$receipt;applicationWitnesses='Separate original driver stage/input/final report verification required';fixtureDeletion=$false;admissionDeletion=$false;completedAtUtc=[DateTime]::UtcNow.ToString('o')}
$terminalStream = [IO.File]::Open((Join-Path $OutputDirectory 'controller-terminal.json'),[IO.FileMode]::CreateNew)
try { $terminalBytes=[Text.Encoding]::UTF8.GetBytes(($terminal|ConvertTo-Json -Depth 15));$terminalStream.Write($terminalBytes,0,$terminalBytes.Length);$terminalStream.Flush($true) } finally { $terminalStream.Dispose() }
if ($receipt.Outcome -cne 'original-job-and-pipes-closed') { exit 1 }
