param([string]$Controller = (Join-Path $PSScriptRoot 'Invoke-WorkerRecovery.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Controller,[ref]$tokens,[ref]$errors)
if (@($errors).Count) { throw 'Recovery controller does not parse' }
foreach ($name in @('Check-Window','Check-Pin','Check-Table')) {
    $definition = $ast.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    },$false)
    if (-not $definition) { throw "Missing admission function $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
$entryClock = [Diagnostics.Stopwatch]::StartNew()
$root = Join-Path ([IO.Path]::GetTempPath()) ('recovery-admission-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory((Join-Path $root 'child')) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'child/regular.txt'),'abc',[Text.UTF8Encoding]::new($false))
$digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('abc'))).ToLowerInvariant()
$good = [pscustomobject]@{path='child/regular.txt';bytes=3;sha256=$digest}
$passed = 0
function Refuses([scriptblock]$operation,[string]$message) {
    try { & $operation } catch {
        if ($_.Exception.Message.Contains($message)) { return }
        throw
    }
    throw "Expected admission refusal: $message"
}
Check-Table $root @($good); $passed++
Refuses { Check-Table $root @([pscustomobject]@{path=$good.path;bytes=3;sha256=('a'*64)}) } 'Pin digest changed'; $passed++
Refuses { Check-Table $root @([pscustomobject]@{path=$good.path;bytes=4;sha256=$digest}) } 'Pin shape/bytes changed'; $passed++
Refuses { Check-Table $root @([pscustomobject]@{path='child';bytes=3;sha256=$digest}) } 'Pin shape/bytes changed'; $passed++
Refuses { Check-Table $root @([pscustomobject]@{path='../outside';bytes=3;sha256=$digest}) } 'Path alias/escape'; $passed++
Refuses { Check-Table $root @($good,[pscustomobject]@{path='CHILD/REGULAR.TXT';bytes=3;sha256=$digest}) } 'Duplicate path'; $passed++
New-Item -ItemType Junction -Path (Join-Path $root 'linked') -Target (Join-Path $root 'child') | Out-Null
Refuses { Check-Table $root @([pscustomobject]@{path='linked/regular.txt';bytes=3;sha256=$digest}) } 'Junction/symlink refused'; $passed++
Refuses { Check-Table (Join-Path $root 'linked') @([pscustomobject]@{path='regular.txt';bytes=3;sha256=$digest}) } 'Junction/symlink refused'; $passed++
[pscustomobject]@{admissionCases=$passed;pass=$passed;fail=0;fixtureRetained=$root} | ConvertTo-Json -Compress
