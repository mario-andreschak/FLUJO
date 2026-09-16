// Run the real repository functions against disposable Git fixtures and the
// Windows flag/build-stage paths with intercepted commands. No package manager,
// registration, app build, server stop/start or network runs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const gitBinary = process.platform === 'win32'
  ? execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
  : 'git';
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : '/bin/bash';
const ps = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : null;
const git = (cwd, ...args) => execFileSync(gitBinary, ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const official = 'https://github.com/mario-andreschak/FLUJO.git';

function extract(file, name, powershell = false) {
  const source = readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const pattern = powershell ? `^function ${name} \\{[\\s\\S]*?^\\}` : `^${name}\\(\\) \\{[\\s\\S]*?^\\}`;
  const result = source.match(new RegExp(pattern, 'm'));
  assert.ok(result, `missing function ${name}`);
  return result[0];
}

function fixture(t) {
  const temporary = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(temporary, 'flujo-installer-repo-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporary);
    assert.ok(path.basename(directory).startsWith('flujo-installer-repo-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const upstream = path.join(directory, 'upstream');
  const checkout = path.join(directory, 'checkout');
  execFileSync(gitBinary, ['init', '-b', 'main', upstream], { stdio: 'pipe', windowsHide: true });
  git(upstream, 'config', 'user.name', 'Installer Test');
  git(upstream, 'config', 'user.email', 'installer@example.invalid');
  writeFileSync(path.join(upstream, 'package.json'), '{"name":"flujo-ai"}\n');
  writeFileSync(path.join(upstream, 'work.txt'), 'initial\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'fixture initial');
  execFileSync(gitBinary, ['clone', upstream, checkout], { stdio: 'pipe', windowsHide: true });
  git(checkout, 'config', 'user.name', 'Installer Test');
  git(checkout, 'config', 'user.email', 'installer@example.invalid');
  git(checkout, 'remote', 'set-url', 'origin', official);
  const before = git(checkout, 'rev-parse', 'HEAD');
  writeFileSync(path.join(upstream, 'work.txt'), 'upstream update\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'fixture update');
  git(upstream, 'tag', 'v9.9.9');
  return { directory, upstream, checkout, before, after: git(upstream, 'rev-parse', 'HEAD') };
}

function update(f, shell, ref = 'main', revision = '', updaterPreflight = false) {
  const env = { ...process.env, FLUJO_FIXTURE_DIR: f.checkout, FLUJO_FIXTURE_REMOTE: f.upstream.replaceAll('\\', '/'), FLUJO_FIXTURE_GIT: gitBinary, FLUJO_FIXTURE_REF: ref, FLUJO_REVISION: revision };
  let content;
  if (shell === 'powershell') {
    content = `$ErrorActionPreference = 'Stop'
. '${path.join(root, 'scripts/installer-functions.ps1').replaceAll("'", "''")}'
$InstallDir = $env:FLUJO_FIXTURE_DIR
$Dir = $InstallDir
Set-Location -LiteralPath $Dir
$Branch = $env:FLUJO_FIXTURE_REF
$isReleaseRef = $Branch -match '^v\\d+\\.\\d+\\.\\d+$'
$installerEnvironment = @{}
function git {
  $forwarded = @($args)
  if ($forwarded -contains 'fetch') { $forwarded = @('-c', ('url.' + $env:FLUJO_FIXTURE_REMOTE + '.insteadOf=${official}')) + $forwarded }
  & $env:FLUJO_FIXTURE_GIT @forwarded
}
function Invoke-InstallerCommand {
  param($Stage, $Command, $Arguments, $Environment)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Git operation failed' }
}
${(updaterPreflight ? ['Read-UpdateGit', 'Assert-UpdateCheckout', 'Get-SafeUpdatePlan'] : ['Read-InstallerGit', 'Assert-InstallerRepository', 'Update-InstallerRepository']).map((name) => extract(updaterPreflight ? 'scripts/update.ps1' : 'scripts/install.ps1', name, true)).join('\n')}
${updaterPreflight ? '$plan = Get-SafeUpdatePlan; Write-Output $plan.Revision' : 'Update-InstallerRepository'}
`;
  } else {
    content = `set -euo pipefail
INSTALL_DIR="$FLUJO_FIXTURE_DIR"
BRANCH="$FLUJO_FIXTURE_REF"
INSTALL_CHANNEL=development
[[ "$BRANCH" != v* ]] || INSTALL_CHANNEL=stable
die() { printf '%s\\n' "$1" >&2; exit 1; }
git() {
  local token
  for token in "$@"; do
    if [ "$token" = fetch ]; then command "$FLUJO_FIXTURE_GIT" -c "url.$FLUJO_FIXTURE_REMOTE.insteadOf=${official}" "$@"; return; fi
  done
  command "$FLUJO_FIXTURE_GIT" "$@"
}
run_stage() { shift; "$@"; }
${['validate_existing_repository', 'update_existing_repository'].map((name) => extract('scripts/install.sh', name)).join('\n')}
update_existing_repository
`;
  }
  const script = path.join(f.directory, shell === 'powershell' ? 'update.ps1' : 'update.sh');
  writeFileSync(script, content);
  return spawnSync(shell === 'powershell' ? ps : bash, shell === 'powershell'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] : [script],
  { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}

for (const shell of ['bash', ...(ps ? ['powershell'] : [])]) {
  test(`${shell}: clean checkout updates by fast-forward and preserves ignored user data`, { skip: shell === 'bash' && !existsSync(bash) }, (t) => {
    const f = fixture(t);
    writeFileSync(path.join(f.checkout, '.git/info/exclude'), 'user-data.json\n');
    writeFileSync(path.join(f.checkout, 'user-data.json'), 'keep me');
    const result = update(f, shell);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.after);
    assert.equal(readFileSync(path.join(f.checkout, 'user-data.json'), 'utf8'), 'keep me');
  });

  for (const scenario of ['dirty', 'untracked', 'unrelated', 'ahead', 'different-branch']) {
    test(`${shell}: refuses ${scenario} checkout without changing its work or HEAD`, { skip: shell === 'bash' && !existsSync(bash) }, (t) => {
      const f = fixture(t);
      if (scenario === 'dirty') writeFileSync(path.join(f.checkout, 'work.txt'), 'my uncommitted work');
      if (scenario === 'untracked') writeFileSync(path.join(f.checkout, 'new-work.txt'), 'my new work');
      if (scenario === 'unrelated') git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
      if (scenario === 'ahead') { writeFileSync(path.join(f.checkout, 'local.txt'), 'local commit'); git(f.checkout, 'add', '.'); git(f.checkout, 'commit', '-m', 'local work'); }
      if (scenario === 'different-branch') git(f.checkout, 'checkout', '-b', 'my-feature');
      const before = git(f.checkout, 'rev-parse', 'HEAD');
      const status = git(f.checkout, 'status', '--porcelain');
      const work = readFileSync(path.join(f.checkout, 'work.txt'), 'utf8');
      const result = update(f, shell);
      assert.notEqual(result.status, 0, 'unsafe update unexpectedly succeeded');
      assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before);
      assert.equal(git(f.checkout, 'status', '--porcelain'), status);
      assert.equal(readFileSync(path.join(f.checkout, 'work.txt'), 'utf8'), work);
    });
  }

  test(`${shell}: release update pins the requested tag and repeat install is safe`, { skip: shell === 'bash' && !existsSync(bash) }, (t) => {
    const f = fixture(t);
    let result = update(f, shell, 'v9.9.9', f.after);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.after);
    assert.equal(git(f.checkout, 'branch', '--show-current'), '');
    result = update(f, shell, 'v9.9.9', f.after);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('Windows release refuses a moved tag before changing checkout', { skip: !ps }, (t) => {
  const f = fixture(t);
  const result = update(f, 'powershell', 'v9.9.9', 'a'.repeat(40));
  assert.notEqual(result.status, 0);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.before);
});

for (const scenario of ['clean', 'dirty', 'detached', 'ahead', 'unrelated']) {
  test(`Windows self-updater preflight ${scenario} preserves checkout before any server stop`, { skip: !ps }, (t) => {
    const f = fixture(t);
    if (scenario === 'dirty') writeFileSync(path.join(f.checkout, 'work.txt'), 'my edit');
    if (scenario === 'detached') git(f.checkout, 'checkout', '--detach');
    if (scenario === 'ahead') { writeFileSync(path.join(f.checkout, 'local.txt'), 'commit'); git(f.checkout, 'add', '.'); git(f.checkout, 'commit', '-m', 'local'); }
    if (scenario === 'unrelated') git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    const before = git(f.checkout, 'rev-parse', 'HEAD');
    const status = git(f.checkout, 'status', '--porcelain');
    const result = update(f, 'powershell', 'main', '', true);
    if (scenario === 'clean') { assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.includes(f.after)); }
    else assert.notEqual(result.status, 0, 'unsafe updater preflight succeeded');
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), before);
    assert.equal(git(f.checkout, 'status', '--porcelain'), status);
  });
}

test('self-updater completes safety preflight before stopping a server and never resets', () => {
  const source = readFileSync(path.join(root, 'scripts/update.ps1'), 'utf8');
  assert.ok(source.indexOf('$updatePlan = Get-SafeUpdatePlan') < source.indexOf('    Stop-Port $Port'));
  assert.ok(!source.includes('git reset --hard'));
  assert.ok(source.includes('git merge --ff-only'));
});

function runPowerShellBehavior(t, source, overrides = {}) {
  const temporary = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(temporary, 'flujo-installer-behavior-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporary);
    assert.ok(path.basename(directory).startsWith('flujo-installer-behavior-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const script = path.join(directory, 'behavior.ps1');
  const commands = path.join(directory, 'commands.txt');
  writeFileSync(script, source);
  writeFileSync(commands, '');
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: { ...process.env, FLUJO_TEST_COMMANDS: commands, ...overrides },
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  return { ...result, commands: readFileSync(commands, 'utf8').trim().split(/\r?\n/).filter(Boolean) };
}

const flagCases = [
  { label: 'wizard choices', shortcut: '1', start: '0', expectedShortcut: true, expectedStart: false },
  ...['0', 'false', 'no'].map((value) => ({ label: `disabled ${value}`, shortcut: value, start: value, expectedShortcut: false, expectedStart: false })),
  ...['1', 'true', 'yes'].map((value) => ({ label: `enabled ${value}`, shortcut: value, start: value, expectedShortcut: true, expectedStart: true })),
  { label: 'unset choices still prompt', shortcut: '', start: '', expectedShortcut: false, expectedStart: false, prompts: 2 },
  { label: 'explicit Start switch retains priority', shortcut: '0', start: '0', switchPresent: true, expectedShortcut: false, expectedStart: true },
];
for (const scenario of flagCases) {
  test(`Windows installer honors ${scenario.label}`, { skip: !ps }, (t) => {
    const source = readFileSync(path.join(root, 'scripts/install.ps1'), 'utf8');
    const start = source.indexOf('# Decide whether to create a Desktop shortcut');
    const end = source.indexOf('# Decide whether to install Ollama');
    assert.ok(start > 0 && end > start);
    const result = runPowerShellBehavior(t, `$ErrorActionPreference = 'Stop'
$script:prompts = 0
function Read-Host { $script:prompts++; return 'n' }
$Start = [PSCustomObject]@{ IsPresent = $${Boolean(scenario.switchPresent)} }
${source.slice(start, end)}
@{ shortcut = $makeShortcut; start = $startAfter; prompts = $script:prompts } | ConvertTo-Json -Compress
`, { FLUJO_SHORTCUT: scenario.shortcut, FLUJO_START: scenario.start });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { shortcut: scenario.expectedShortcut, start: scenario.expectedStart, prompts: scenario.prompts ?? 0 });
  });
}

const updateCommands = ['npm ci --include=dev', 'npm run build', 'npm run validate:mcp-release'];
for (const failedCommand of [...updateCommands, '']) {
  test(`Windows updater ${failedCommand ? `stops after failed ${failedCommand}` : 'starts only after every build stage passes'}`, { skip: !ps }, (t) => {
    const source = readFileSync(path.join(root, 'scripts/update.ps1'), 'utf8');
    const start = source.indexOf('# Install with dev dependencies:');
    const end = source.indexOf('# 5. Wait');
    assert.ok(start > 0 && end > start);
    const result = runPowerShellBehavior(t, `$ErrorActionPreference = 'Continue'
function Log([string]$m) { Write-Output $m }
function cmd.exe {
  $command = $args[-1]
  Add-Content -LiteralPath $env:FLUJO_TEST_COMMANDS -Value $command
  $code = if ($command -eq $env:FLUJO_TEST_FAILED_COMMAND) { 37 } else { 0 }
  & $env:ComSpec /d /c "exit /b $code"
  $global:LASTEXITCODE = $LASTEXITCODE
}
function Start-Process { Add-Content -LiteralPath $env:FLUJO_TEST_COMMANDS -Value 'START' }
${extract('scripts/update.ps1', 'Invoke-UpdateCommand', true)}
${source.slice(start, end)}
`, { FLUJO_TEST_FAILED_COMMAND: failedCommand });
    if (failedCommand) {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /failed with exit code 37.*not restarted/);
      assert.deepEqual(result.commands, updateCommands.slice(0, updateCommands.indexOf(failedCommand) + 1));
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.commands, [...updateCommands, 'START']);
    }
  });
}
