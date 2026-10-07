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
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/ea592-original-producer-root-join-v2/review.json",
    "bytes": 4206,
    "sha256": "15a4ab6a443e31c326b7d0e2e2d7f76764c3007f41c2c0129c830a187171bd57"
  },
  "originalProducerResult": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/result.json",
    "bytes": 23917,
    "sha256": "0ce089b1e4af1df7fc34ab9de568d10f321d6adb986224aa71bb5accd2a0922f"
  },
  "buildReceipt": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/ordinary-production-build-original-result.json",
    "bytes": 12670,
    "sha256": "1c8d6746c4aadb22961bd4c78f6ab66a2dbe15842c43fd8afccf477a3ccac171"
  },
  "packReceipt": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/five-actual-packages-original-result.json",
    "bytes": 5172,
    "sha256": "2d515dc2b881e8183bf3f131de0eaaffa7974fd43aa025b510d2be8daebf3f9c"
  },
  "archive": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/flujo-ai-3.46.3.tgz",
    "bytes": 10344082,
    "sha256": "f1ed62b496610d09afc82b7bbfa16a1ec13a5e65e69ed31fbe0bcac3d2dcd1e7"
  },
  "graphReceipt": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/after-complete-own91930-graph.json",
    "bytes": 27318857,
    "sha256": "951e9dc94cbc9ae840badefff0e390cb802e88a0e4257e642bc7b9a768593323"
  },
  "artifactJoin": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/five-original-packages-artifact-join.json",
    "bytes": 5670,
    "sha256": "786136c8fbd09692c78f3c95e709ff1d9da743eb899e6116eee28fb51f17fdec"
  },
  "generatedOutputReceipt": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/after-complete-generated-output-pins.json",
    "bytes": 706581,
    "sha256": "c63195b19c672400ffc130b78f9f83f4e9c11230e4e1cd5e61e43c028c35624f"
  },
  "originalEvidence": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/completed-original-producer-evidence-pins.json",
    "bytes": 241946,
    "sha256": "5e0f3a57460f385a17d10798901671373e6cde7b318ecf03c0dce29d64055eb8"
  },
  "graphRootReview": {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a10377-6ce9-72a3-9ae6-dc21476275eb/ea592-source-own-graph-root-v1/review.json",
    "bytes": 4298,
    "sha256": "317d3c3cfe7717958eff9622d888a1e9a35f654b7e213830c55209dc760d9d45"
  }
}
'@ | ConvertFrom-Json
$expectedPackageArchives = @'
[
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/flujo-ai-3.46.3.tgz",
    "bytes": 10344082,
    "sha256": "f1ed62b496610d09afc82b7bbfa16a1ec13a5e65e69ed31fbe0bcac3d2dcd1e7"
  },
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/mario.andreschak-mcp-filesystem-3.46.3.tgz",
    "bytes": 56613,
    "sha256": "918435f4274c5d84ffafc07e1c0b5bcf662af768cbe27319b3b78a1679e50a21"
  },
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/mario.andreschak-mcp-bash-3.46.3.tgz",
    "bytes": 57885,
    "sha256": "a8cb28f8d9734cbed4764a8ec0388f80f1ea77999b7b045c56e9c378c1f44755"
  },
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/mario.andreschak-mcp-browser-3.46.3.tgz",
    "bytes": 95401,
    "sha256": "1ed59e83050e60b7f77ef92d6adf4f897a382202623cc0af9213310cdadc95fa"
  },
  {
    "path": "C:/Users/Moe/.codex/visualizations/2026/10/03/01a103aa-de4b-70c0-922c-8ff43432af13/engineering-evidence/ea592-ordinary-producer-prospective-20261007-v1/original-producer-entry-v1/artifacts/mario.andreschak-mcp-flujo-3.46.3.tgz",
    "bytes": 11678,
    "sha256": "40c9d29272aaa98363770cccdb9f305134cb76bb94fdc3a0f7b339bd88f6caa6"
  }
]
'@ | ConvertFrom-Json
function Check-Window {
    if ($entryClock.ElapsedMilliseconds -ge 60_000) { throw 'Controller preentry deadline exceeded' }
}
function Check-Pin($pin) {
    Check-Window
    if (-not [IO.Path]::IsPathFullyQualified($pin.path)) { throw 'Absolute pin required' }
    $item = Get-Item -LiteralPath $pin.path
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $pin.bytes) { throw 'Pin shape/bytes changed' }
    if ((Get-FileHash -LiteralPath $pin.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256) { throw 'Pin digest changed' }
    Check-Window
}
function Check-Table([string]$root, $files) {
    if (-not [IO.Path]::IsPathFullyQualified($root) -or $files.Count -lt 1 -or $files.Count -gt 100_000) { throw 'Root/file census refused' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$bytes = 0
    foreach ($file in $files) {
        if ($file.path.Length -gt 1024 -or $file.path -match '[\\:\x00-\x1f]' -or $file.path.StartsWith('/')) { throw 'Invalid relative path' }
        $parts = $file.path.Split('/')
        if ($parts | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$' }) { throw 'Path alias/escape' }
        if (-not $seen.Add($file.path)) { throw 'Duplicate path' }
        if ($file.bytes -lt 0 -or $file.bytes -gt 268435456 -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid file pin' }
        $bytes += $file.bytes; if ($bytes -gt 34359738368) { throw 'Table byte budget exceeded' }
        $current = [IO.Path]::GetFullPath($root)
        foreach ($part in @('') + $parts) {
            if ($part) { $current = Join-Path $current $part }
            if ((Get-Item -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Junction/symlink refused' }
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
