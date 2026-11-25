// Run the real repository functions against disposable Git fixtures and the
// Windows flag/build-stage paths with intercepted commands. No package manager,
// registration, app build, server stop/start or network runs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function assertUpdaterProcessExited(result) {
  const diagnostic = `Updater process: status=${result.status}, signal=${result.signal}, error=${result.error?.code ?? 'none'}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.signal, null, diagnostic);
  assert.ok(Number.isInteger(result.status), diagnostic);
}

test('a real child deadline cannot count as a safe checkout refusal', () => {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("deadline-control-entered\\n"); setTimeout(() => {}, 60_000);'],
    { encoding: 'utf8', windowsHide: true, timeout: 1_000 });
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.match(result.stdout, /deadline-control-entered/);
  assert.notEqual(result.status, 0); // The previous refusal check accepted this result.
  assert.throws(() => assertUpdaterProcessExited(result), /error=ETIMEDOUT/);
});

function update(f, shell, ref = 'main', revision = '', updaterPreflight = false, { remote = f.upstream.replaceAll('\\', '/'), rewrite = 'fetch' } = {}) {
  const env = { ...process.env, FLUJO_FIXTURE_DIR: f.checkout, FLUJO_FIXTURE_REMOTE: remote, FLUJO_FIXTURE_REWRITE: rewrite, FLUJO_FIXTURE_GIT: gitBinary, FLUJO_FIXTURE_REF: ref, FLUJO_REVISION: revision };
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
  $rewriteAll = $env:FLUJO_FIXTURE_REWRITE -eq 'all' -and -not (' ' + ($forwarded -join ' ') + ' ').Contains(' remote get-url ')
  if ($rewriteAll -or $forwarded -contains 'fetch') { $forwarded = @('-c', ('url.' + $env:FLUJO_FIXTURE_REMOTE + '.insteadOf=${official}')) + $forwarded }
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
  if [ "$FLUJO_FIXTURE_REWRITE" = all ] && [[ " $* " != *" remote get-url "* ]]; then
    command "$FLUJO_FIXTURE_GIT" -c "url.$FLUJO_FIXTURE_REMOTE.insteadOf=${official}" "$@"; return
  fi
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
  const result = spawnSync(shell === 'powershell' ? ps : bash, shell === 'powershell'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] : [script],
  { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  // A deadline or launch failure is not evidence that the updater refused an unsafe checkout.
  assertUpdaterProcessExited(result);
  return result;
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

// A new install fetches only the chosen version's files and leaves the website
// out (#570). The upstream fixture allows partial clones like GitHub does.
function websiteFixture(t) {
  const temporary = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(temporary, 'flujo-installer-repo-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporary);
    rmSync(directory, { recursive: true, force: true });
  });
  const upstream = path.join(directory, 'upstream');
  execFileSync(gitBinary, ['init', '-b', 'main', upstream], { stdio: 'pipe', windowsHide: true });
  git(upstream, 'config', 'user.name', 'Installer Test');
  git(upstream, 'config', 'user.email', 'installer@example.invalid');
  git(upstream, 'config', 'uploadpack.allowFilter', 'true');
  git(upstream, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const write = (file, content) => { mkdirSync(path.dirname(path.join(upstream, file)), { recursive: true }); writeFileSync(path.join(upstream, file), content); };
  write('package.json', '{"name":"flujo-ai"}\n');
  write('work.txt', 'initial\n');
  write('githubpages/index.html', '<html></html>\n');
  write('githubpages/film/walkthrough.mp4', randomBytes(256 * 1024));
  write('githubpages/oauth/client-metadata.json', '{"client_id":"fixture"}\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'fixture with website');
  // An older video version only exists in history; a partial clone never downloads it.
  write('githubpages/film/walkthrough.mp4', randomBytes(256 * 1024));
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'fixture with new video');
  return { directory, upstream, write, checkout: path.join(directory, 'installed'), url: pathToFileURL(upstream).href,
    oldVideo: git(upstream, 'rev-parse', 'HEAD~1:githubpages/film/walkthrough.mp4'), video: git(upstream, 'rev-parse', 'HEAD:githubpages/film/walkthrough.mp4') };
}

function clone(f, shell, { partial = true } = {}) {
  const env = { ...process.env, FLUJO_FIXTURE_DIR: f.checkout, FLUJO_FIXTURE_URL: f.url, FLUJO_FIXTURE_GIT: gitBinary, FLUJO_FIXTURE_MANIFEST: path.join(f.directory, 'manifest') };
  const content = shell === 'powershell' ? `$ErrorActionPreference = 'Stop'
$InstallDir = $env:FLUJO_FIXTURE_DIR
$Branch = 'main'
$RepoUrl = $env:FLUJO_FIXTURE_URL
$installerEnvironment = @{}
function git { & $env:FLUJO_FIXTURE_GIT @args }
function Invoke-InstallerCommand {
  param($Stage, $Command, $Arguments, $Environment)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Git operation failed' }
}
${['Test-InstallerPartialClone', 'Install-InstallerRepository'].map((name) => extract('scripts/install.ps1', name, true)).join('\n')}
${partial ? '' : 'function Test-InstallerPartialClone { return $false }'}
Install-InstallerRepository
` : `set -euo pipefail
INSTALL_DIR="$FLUJO_FIXTURE_DIR"
BRANCH=main
REPO_URL="$FLUJO_FIXTURE_URL"
MANIFEST_DIR="$FLUJO_FIXTURE_MANIFEST"
git() { command "$FLUJO_FIXTURE_GIT" "$@"; }
run_stage() { shift; "$@"; }
${['git_supports_partial_clone', 'clone_repository'].map((name) => extract('scripts/install.sh', name)).join('\n')}
${partial ? '' : 'git_supports_partial_clone() { return 1; }'}
clone_repository
`;
  const script = path.join(f.directory, shell === 'powershell' ? 'clone.ps1' : 'clone.sh');
  writeFileSync(script, content);
  const result = spawnSync(shell === 'powershell' ? ps : bash, shell === 'powershell'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] : [script],
  { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assertUpdaterProcessExited(result);
  return result;
}

const missingObjects = (checkout) => git(checkout, 'rev-list', '--objects', '--all', '--missing=print')
  .split(/\r?\n/).filter((line) => line.startsWith('?')).map((line) => line.slice(1));

for (const shell of ['bash', ...(ps ? ['powershell'] : [])]) {
  test(`${shell}: a new install downloads only the chosen version and leaves the website out`, { skip: shell === 'bash' && !existsSync(bash) }, (t) => {
    const f = websiteFixture(t);
    const result = clone(f, shell);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), git(f.upstream, 'rev-parse', 'HEAD'));
    assert.equal(git(f.checkout, 'config', 'remote.origin.partialclonefilter'), 'blob:none');
    assert.ok(existsSync(path.join(f.checkout, 'package.json')));
    assert.equal(readFileSync(path.join(f.checkout, 'githubpages/oauth/client-metadata.json'), 'utf8').replace(/\r\n/g, '\n'), '{"client_id":"fixture"}\n');
    assert.equal(existsSync(path.join(f.checkout, 'githubpages/film/walkthrough.mp4')), false);
    assert.equal(existsSync(path.join(f.checkout, 'githubpages/index.html')), false);
    const missing = missingObjects(f.checkout);
    assert.ok(missing.includes(f.video) && missing.includes(f.oldVideo), 'neither the current nor the old video was downloaded');
    assert.equal(git(f.checkout, 'status', '--porcelain', '--untracked-files=normal'), '');

    // The ordinary update path keeps working on the smaller checkout.
    git(f.checkout, 'remote', 'set-url', 'origin', official);
    f.write('work.txt', 'upstream update\n');
    f.write('githubpages/short/voiceover.mp3', randomBytes(64 * 1024));
    git(f.upstream, 'add', '.'); git(f.upstream, 'commit', '-m', 'fixture update');
    const updated = update(f, shell, 'main', '', false, { remote: f.url, rewrite: 'all' });
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), git(f.upstream, 'rev-parse', 'HEAD'));
    assert.equal(readFileSync(path.join(f.checkout, 'work.txt'), 'utf8').replace(/\r\n/g, '\n'), 'upstream update\n');
    assert.equal(existsSync(path.join(f.checkout, 'githubpages/short/voiceover.mp3')), false);
    assert.equal(git(f.checkout, 'status', '--porcelain', '--untracked-files=normal'), '');
  });

  test(`${shell}: older Git without partial clone still gets a working checkout without the website`, { skip: shell === 'bash' && !existsSync(bash) }, (t) => {
    const f = websiteFixture(t);
    const result = clone(f, shell, { partial: false });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(spawnSync(gitBinary, ['-C', f.checkout, 'config', 'remote.origin.partialclonefilter'], { windowsHide: true }).status, 1);
    assert.deepEqual(missingObjects(f.checkout), []);
    assert.ok(existsSync(path.join(f.checkout, 'githubpages/oauth/client-metadata.json')));
    assert.equal(existsSync(path.join(f.checkout, 'githubpages/film/walkthrough.mp4')), false);
    assert.equal(git(f.checkout, 'status', '--porcelain', '--untracked-files=normal'), '');
  });

  test(`${shell}: partial clone is used from Git 2.25 on`, { skip: shell === 'bash' && !existsSync(bash) }, (t) => {
    const directory = mkdtempSync(path.join(path.resolve(tmpdir()), 'flujo-installer-repo-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [version, expected] of [['git version 2.24.9', false], ['git version 2.25.0', true], ['git version 2.39.3 (Apple Git-145)', true],
      ['git version 2.47.1.windows.1', true], ['git version 3.0.0', true], ['git version 1.9.5', false], ['not git', false]]) {
      const script = path.join(directory, shell === 'powershell' ? 'probe.ps1' : 'probe.sh');
      writeFileSync(script, shell === 'powershell'
        ? `function git { Write-Output $env:FAKE_GIT_VERSION; $global:LASTEXITCODE = 0 }\n${extract('scripts/install.ps1', 'Test-InstallerPartialClone', true)}\nif (Test-InstallerPartialClone) { exit 0 } else { exit 1 }\n`
        : `git() { printf '%s\\n' "$FAKE_GIT_VERSION"; }\n${extract('scripts/install.sh', 'git_supports_partial_clone')}\ngit_supports_partial_clone\n`);
      const result = spawnSync(shell === 'powershell' ? ps : bash, shell === 'powershell'
        ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] : [script],
      { env: { ...process.env, FAKE_GIT_VERSION: version }, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      assertUpdaterProcessExited(result);
      assert.equal(result.status === 0, expected, `${version}: ${result.stderr}`);
    }
  });
}

test('app code reads website files only where both installers and the Docker image keep them', () => {
  const kept = 'githubpages/oauth/client-metadata.json';
  const source = (file) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source('scripts/install.sh').includes(`printf '%s\\n' '/*' '!/githubpages/' '/${kept}'`), 'install.sh keeps the OAuth metadata only');
  assert.ok(source('scripts/install.ps1').includes(`"/*\`n!/githubpages/\`n/${kept}\`n"`), 'install.ps1 keeps the same files as install.sh');
  assert.ok(source('.dockerignore').includes(`!${kept}`), '.dockerignore keeps the same file');
  const references = [];
  const walk = (directory) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) {
        for (const match of source(relative).matchAll(/githubpages\/[\w./-]*/g)) references.push({ file: relative, target: match[0] });
      }
    }
  };
  for (const directory of ['src', 'bin']) walk(directory);
  assert.ok(references.length > 0, 'the OAuth metadata import is found');
  for (const { file, target } of references) {
    assert.equal(target, kept, `${file} reads ${target}, but new installs and the Docker image leave the website folder out. `
      + `Keep app data out of githubpages/, or change the kept files in scripts/install.sh, scripts/install.ps1 and .dockerignore together.`);
  }
});

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
