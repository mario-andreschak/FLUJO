import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { assertSupportedNodeRuntime, isSupportedNodeRuntime, SUPPORTED_NODE_RANGE } from '../bin/node-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servers = ['bash', 'browser', 'filesystem', 'flujo'];
const versions = [
  ['20.19.0', false], ['22.0.0', false], ['22.13.1', false], ['22.16.9', false],
  ['22.17.0', true], ['v22.17.0', true], ['22.18.1', true], ['22.99.99', true],
  ['23.0.0', false], ['23.11.0', false], ['24.0.0', false], ['24.1.9', false],
  ['24.2.0', true], ['24.21.0', true], ['25.0.0', false], ['26.0.0', false],
  ['100.0.0', false], ['22.17', false], ['022.17.0', false], ['22.017.0', false],
  ['22.17.0-rc.1', false], ['22.17.0+custom', false], ['22.17.2147483648', false],
  ['', false], [undefined, false], [22, false],
];

for (const [version, supported] of versions) {
  test(`runtime ${String(version)} is ${supported ? 'supported' : 'refused'}`, () => {
    assert.equal(isSupportedNodeRuntime(version), supported);
    if (supported) assert.doesNotThrow(() => assertSupportedNodeRuntime(version));
    else assert.throws(() => assertSupportedNodeRuntime(version), { code: 'UNSUPPORTED_NODE_RUNTIME' });
  });
}

test('runtime errors contain bounded migration guidance without interpolating probe input', () => {
  assert.throws(() => assertSupportedNodeRuntime('secret-probe-value'), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_NODE_RUNTIME');
    assert.match(error.message, /current patched release/);
    assert.ok(!error.message.includes('secret-probe-value'));
    return true;
  });
});

test('all six tracked engines and corresponding lock entries declare the closed runtime range', () => {
  assert.equal(SUPPORTED_NODE_RANGE, '^22.17.0 || ^24.2.0');
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const directory of ['', ...[...servers, 'shared'].map((server) => `mcp-servers/${server}`)]) {
    const manifest = JSON.parse(readFileSync(path.join(root, directory, 'package.json'), 'utf8'));
    assert.equal(manifest.engines.node, SUPPORTED_NODE_RANGE, directory);
    assert.equal(lock.packages[directory].engines.node, SUPPORTED_NODE_RANGE, directory);
    if (directory && directory !== 'mcp-servers/shared') assert.match(manifest.scripts.build, /&& node \.\.\/embed-runtime\.mjs \w+$/);
  }
});

test('public entry points import the preflight before other dependencies', () => {
  for (const file of ['bin/flujo.mjs', ...servers.map((server) => `mcp-servers/${server}/src/index.ts`)]) {
    const source = readFileSync(path.join(root, file), 'utf8');
    const firstImport = source.match(/^import .*$/m)?.[0];
    assert.match(firstImport, /^import '(\.\/|\.\.\/\.\.\/\.\.\/bin\/)node-runtime-preflight\.mjs';\r?$/, file);
  }
});

function fixture(t) {
  const tempRoot = realpathSync.native(os.tmpdir());
  const directory = realpathSync.native(mkdtempSync(path.join(tempRoot, 'flujo-runtime-contract-')));
  t.after(() => {
    assert.equal(realpathSync.native(directory), directory);
    const relative = path.relative(tempRoot, directory);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('embedding makes all four MCP entry preflights independent of repository paths', (t) => {
  const directory = fixture(t);
  mkdirSync(path.join(directory, 'bin'));
  mkdirSync(path.join(directory, 'mcp-servers'));
  for (const file of ['node-runtime.mjs', 'node-runtime-preflight.mjs', 'node-runtime-preflight.d.mts']) {
    writeFileSync(path.join(directory, 'bin', file), readFileSync(path.join(root, 'bin', file)));
  }
  const helper = path.join(directory, 'mcp-servers/embed-runtime.mjs');
  writeFileSync(helper, readFileSync(path.join(root, 'mcp-servers/embed-runtime.mjs')));
  for (const server of servers) {
    const dist = path.join(directory, 'mcp-servers', server, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, 'index.js'), "#!/usr/bin/env node\nimport '../../../bin/node-runtime-preflight.mjs';\n");
    writeFileSync(path.join(dist, 'index.d.ts'), "#!/usr/bin/env node\nimport '../../../bin/node-runtime-preflight.mjs';\nexport {};\n");
    const result = spawnSync(process.execPath, [helper, server], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(dist, 'index.js'), 'utf8'), "#!/usr/bin/env node\nimport './node-runtime-preflight.mjs';\n");
    assert.equal(readFileSync(path.join(dist, 'index.d.ts'), 'utf8'), "#!/usr/bin/env node\nimport './node-runtime-preflight.mjs';\nexport {};\n");
    for (const file of ['node-runtime.mjs', 'node-runtime-preflight.mjs', 'node-runtime-preflight.d.mts']) {
      assert.deepEqual(readFileSync(path.join(dist, file)), readFileSync(path.join(root, 'bin', file)));
    }
  }
  const invalid = spawnSync(process.execPath, [helper, '../escape'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
});

test('preflight refuses unsupported versions before a fixture dependency can perform its side effect', (t) => {
  const directory = fixture(t);
  const marker = path.join(directory, 'dependency-ran');
  const dependency = path.join(directory, 'effect.mjs');
  const entry = path.join(directory, 'entry.mjs');
  writeFileSync(dependency, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'owned fixture');\n`);
  writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(path.join(root, 'bin/node-runtime-preflight.mjs')).href)};\nimport './effect.mjs';\n`);
  for (const version of ['22.13.1', '23.11.0', '24.1.9', '25.0.0', '26.0.0']) {
    const code = `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); await import(${JSON.stringify(pathToFileURL(entry).href)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UNSUPPORTED_NODE_RUNTIME/);
    assert.equal(existsSync(marker), false);
  }
  // A synthetic version admits only this harmless fixture; it does not qualify another native runtime.
  const accepted = spawnSync(process.execPath, ['--input-type=module', '--eval', `Object.defineProperty(process.versions, 'node', { value: '22.17.0' }); await import(${JSON.stringify(pathToFileURL(entry).href)});`], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(accepted.error);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(readFileSync(marker, 'utf8'), 'owned fixture');
});

if (process.platform === 'win32') {
  test('Windows installer uses the same version policy and retains missing/failed/malformed probe states', () => {
    const helper = path.join(root, 'scripts/installer-functions.ps1').replaceAll("'", "''");
    const cases = versions.filter(([version]) => typeof version === 'string').map(([version, supported]) => ({ version, supported }));
    const script = `$ErrorActionPreference = 'Stop'\n. '${helper}'\n$cases = '${JSON.stringify(cases).replaceAll("'", "''")}' | ConvertFrom-Json\nforeach ($case in $cases) {\n $value = $case.version\n $result = Test-FlujoNodeVersion -CommandResolver { [PSCustomObject]@{ Source = 'owned-fixture' } } -VersionResolver { $value }\n if (($result.Status -eq 'Supported') -ne $case.supported) { throw 'Runtime policy mismatch' }\n}\nif ((Test-FlujoNodeVersion -CommandResolver { $null }).Status -ne 'Missing') { throw 'Missing state lost' }\nif ((Test-FlujoNodeVersion -CommandResolver { 'fixture' } -VersionResolver { [PSCustomObject]@{ Output = '24.2.0'; ExitCode = 1 } }).Status -ne 'ProbeFailed') { throw 'Failed state lost' }\nWrite-Output 'Windows policy fixture passed'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Windows policy fixture passed/);
  });
  test('Windows installer source refuses unsupported existing Node before prerequisite and policy stages', () => {
    const helper = path.join(root, 'scripts/installer-functions.ps1').replaceAll("'", "''");
    const installer = path.join(root, 'scripts/install.ps1').replaceAll("'", "''");
    const script = `$ErrorActionPreference = 'Stop'
. '${helper}'
$source = Get-Content -LiteralPath '${installer}' -Raw
$start = $source.IndexOf('Write-Step "Validating Node.js version')
$end = $source.IndexOf('# Last question:', $start)
if ($start -lt 0 -or $end -le $start) { throw 'Installer preflight boundary missing' }
$preflight = $source.Substring($start, $end - $start)
$originalProbe = (Get-Command Test-FlujoNodeVersion).ScriptBlock
function Write-Step { param($Text) }
function Write-Ok { param($Text) }
function Write-Warn2 { param($Text) }
foreach ($value in @('22.13.1', '23.11.0', '24.1.9', '25.0.0', '26.0.0', '22.17.0', '24.2.0')) {
 $script:fixtureProbe = & $originalProbe -CommandResolver { 'fixture' } -VersionResolver { $value }
 function Test-FlujoNodeVersion { return $script:fixtureProbe }
 $refused = $false
 try { Invoke-Expression $preflight } catch {
  $refused = $true
  if ($_.Exception.Message -notmatch 'installer will not switch') { throw }
 }
 if ($refused -ne ($script:fixtureProbe.Status -eq 'Outdated')) { throw 'Installer refusal boundary changed' }
}
Write-Output 'Windows source preflight fixture passed'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Windows source preflight fixture passed/);
  });
}

test('Unix installer source refuses unsupported existing Node before package-manager execution', (t) => {
  const directory = fixture(t);
  const source = readFileSync(path.join(root, 'scripts/install.sh'), 'utf8').replaceAll('\r\n', '\n');
  const validator = source.match(/^node_version_ok\(\) \{[\s\S]*?^\}/m)?.[0];
  const stage = source.slice(source.indexOf('# Node.js (includes npm)'), source.indexOf('# Python 3 (many MCP servers'));
  assert.ok(validator && stage.includes('node_version_ok'));
  const entry = path.join(directory, 'installer-stage.sh');
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  for (const [version, supported] of [['22.13.1', false], ['23.11.0', false], ['24.1.9', false], ['26.0.0', false], ['22.17.0', true], ['24.2.0', true]]) {
    writeFileSync(entry, `set -euo pipefail
have() { [ "$1" = node ]; }
node() { printf '%s\\n' '${version}'; }
die() { printf 'FIXTURE_REFUSAL:%s\\n' "$*" >&2; exit 9; }
ok() { :; }
warn() { :; }
step() { :; }
brew() { echo 'PACKAGE_MANAGER_EXECUTED' >&2; exit 12; }
pm_install() { echo 'PACKAGE_MANAGER_EXECUTED' >&2; exit 12; }
SUPPORTED_NODE_DESCRIPTION='closed 22/24 fixture'
PM=brew
${validator}
${stage}
echo FIXTURE_ADMITTED
`);
    const result = spawnSync(bash, [entry.replaceAll('\\', '/')], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, supported ? 0 : 9, result.stderr);
    assert.ok(!result.stderr.includes('PACKAGE_MANAGER_EXECUTED'));
    assert.match(supported ? result.stdout : result.stderr, supported ? /FIXTURE_ADMITTED/ : /FIXTURE_REFUSAL/);
  }
});
