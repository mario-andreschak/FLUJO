import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GUIDE, STAND_INS, guideNodeVersions, parseGuide, planWalkthrough, runServerStep, runShellStep, walk } from './contributor-guide.mjs';

const root = new URL('../', import.meta.url);
const guide = readFileSync(new URL(GUIDE, root), 'utf8');
const posixOnly = { skip: process.platform === 'win32' ? 'runs the Linux and macOS steps with bash' : false };
const fence = '```';

function tempDir(t, prefix) {
  const temp = realpathSync(os.tmpdir());
  const dir = realpathSync(mkdtempSync(path.join(temp, prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const SERVER = `import http from 'node:http';
if (process.argv[3] === 'ignore-ctrl-c') process.on('SIGINT', () => {});
http.createServer((request, response) => {
  if (request.url === '/api/cwd') response.end(JSON.stringify({ success: true }));
  else response.end('<html><body>FLUJO</body></html>');
}).listen(Number(process.argv[2]), '127.0.0.1');
`;

test('the walkthrough follows every Linux and macOS step of the real guide, from clone to dev server and type check', () => {
  const { steps, skipped } = parseGuide(guide);
  const plan = planWalkthrough(steps, { fork: '/tmp/fork/FLUJO.git' });
  const at = (pattern) => plan.findIndex((step) => pattern.test(step.script));
  assert.match(plan[0].script, /^node --version$/m, 'it starts by checking the versions');
  const clone = plan.findIndex((step) => step.clones);
  assert.ok(clone > 0);
  assert.match(plan[clone].script, /^git clone '\/tmp\/fork\/FLUJO\.git'\ncd FLUJO$/m);
  const install = at(/^npm ci --include=dev$/m);
  const build = at(/^npm run build:mcp$/m);
  const jest = at(/^node scripts\/run-local-jest\.cjs /m);
  const server = plan.findIndex((step) => step.kind === 'server');
  const typecheck = at(/^npm run typecheck$/);
  assert.ok(clone < install && install <= build && build < jest && jest < server && server < typecheck,
    'clone, install, build:mcp, a test run, the dev server and the type check, in this order');
  assert.equal(plan[server].url, 'http://127.0.0.1:4300/');
  assert.match(plan[server].script, /^node scripts\/launch-next\.mjs dev .*--port 4300$/);
  assert.match(plan[server - 1].script, /export FLUJO_DATA_DIR=/, 'the throwaway data folder is set before the server starts');
  assert.ok(skipped.some((block) => block.language === 'powershell'), 'the PowerShell block is for Windows readers');
  assert.ok(!plan.some((step) => /<[a-z]|YOUR-/i.test(step.script)), 'every placeholder is filled in');
});

test('the guide asks for exactly the Node.js versions package.json accepts', () => {
  const { engines } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(guideNodeVersions(guide).map((version) => `^${version}`).join(' || '), engines.node);
});

test('parseGuide reads shell blocks, "Run" columns and the server a block ends in', () => {
  const markdown = [
    '# Guide', '', '## One', '', `${fence}sh`, 'echo one', `${fence}`, '',
    '~~~bash', '# a comment', 'export A=1', 'node server.mjs', '~~~', '',
    'Open `http://127.0.0.1:4555` and stop with Ctrl+C.', '',
    `${fence}powershell`, 'Write-Host no', `${fence}`, '',
    `${fence}json`, '{}', `${fence}`, '',
    '## Two', '',
    '| You changed | Run |', '| --- | --- |',
    '| Code | `npm run a`, then `npx b` |',
    '| Docs | `npm run c`, and update `docs/feature-map/` |',
    '## Three', '', `${fence}sh`, 'echo three', `${fence}`,
  ].join('\n');
  const { steps, skipped } = parseGuide(markdown);
  assert.deepEqual(steps.map(({ section, line, kind, script, url }) => ({ section, line, kind, script, url })), [
    { section: 'One', line: 5, kind: 'shell', script: 'echo one', url: undefined },
    { section: 'One', line: 9, kind: 'shell', script: '# a comment\nexport A=1', url: undefined },
    { section: 'One', line: 12, kind: 'server', script: 'node server.mjs', url: 'http://127.0.0.1:4555/' },
    { section: 'Two', line: 29, kind: 'shell', script: 'npm run a', url: undefined },
    { section: 'Two', line: 29, kind: 'shell', script: 'npx b', url: undefined },
    { section: 'Two', line: 30, kind: 'shell', script: 'npm run c', url: undefined },
    { section: 'Three', line: 33, kind: 'shell', script: 'echo three', url: undefined },
  ]);
  assert.deepEqual(skipped.map((block) => block.language), ['powershell', 'json']);
});

test('a placeholder the walkthrough cannot fill in stops it and says where to add a stand-in', () => {
  const steps = [{ section: 'Branch', line: 3, kind: 'shell', script: 'git switch <your branch>' }];
  assert.throws(() => planWalkthrough(steps, {}, []), /line 3 \("Branch"\) has <your branch>.*STAND_INS/);
  assert.throws(() => planWalkthrough([{ ...steps[0], script: 'git clone https://github.com/YOUR-NAME/Other.git' }], {}, []), /YOUR-NAME/);
});

test('a stand-in the guide no longer uses is refused, so the list cannot rot', () => {
  assert.throws(() => planWalkthrough([], { fork: 'x' }), /no longer contains https:\/\/github\.com\/YOUR-NAME\/FLUJO\.git, <test files>, <files>/);
  const all = STAND_INS.map((standIn) => standIn.text).join(' ');
  const [step] = planWalkthrough([{ section: 's', line: 1, kind: 'shell', script: `echo ${all}` }], { fork: "/tmp/it's" });
  assert.equal(step.script, "echo '/tmp/it'\\''s' '__tests__/scripts/localTestDependencies.test.ts' 'scripts/contributor-guide.mjs'");
  assert.equal(step.clones, true);
});

test('shell steps hand their folder and exported variables on, like one terminal', posixOnly, async (t) => {
  const dir = tempDir(t, 'flujo-guide-shell-');
  const options = (name) => ({ logFile: path.join(dir, `${name}.log`), stateFile: path.join(dir, 'state.json') });
  let state = { cwd: dir, env: { ...process.env } };
  state = await runShellStep({ script: 'mkdir inner\ncd inner\nexport GUIDE_GREETING=hello\necho first' }, state, options('one'));
  assert.equal(state.cwd, path.join(dir, 'inner'));
  assert.equal(state.env.GUIDE_GREETING, 'hello');
  state = await runShellStep({ script: 'test "$GUIDE_GREETING" = hello\npwd > where.txt' }, state, options('two'));
  assert.equal(readFileSync(path.join(dir, 'inner', 'where.txt'), 'utf8').trim(), path.join(dir, 'inner'));
  assert.match(readFileSync(path.join(dir, 'one.log'), 'utf8'), /first/);
  await assert.rejects(runShellStep({ script: 'false\necho never' }, state, options('three')), /failed \(exit 1\)/);
  assert.doesNotMatch(readFileSync(path.join(dir, 'three.log'), 'utf8'), /never/);
  await assert.rejects(runShellStep({ script: 'sleep 30' }, state, { ...options('four'), timeoutMs: 500 }), /still running/);
});

test('a server step waits for the guide\'s address to answer, presses Ctrl+C and checks it stopped', posixOnly, async (t) => {
  const dir = tempDir(t, 'flujo-guide-server-');
  writeFileSync(path.join(dir, 'server.mjs'), SERVER);
  const state = { cwd: dir, env: { ...process.env } };
  const port = await freePort();
  const step = { script: `node server.mjs ${port}`, url: `http://127.0.0.1:${port}/` };
  await runServerStep(step, state, { logFile: path.join(dir, 'good.log'), readyMs: 20_000, stopMs: 5_000 });
  const stubborn = { script: `node server.mjs ${port} ignore-ctrl-c`, url: step.url };
  await assert.rejects(runServerStep(stubborn, state, { logFile: path.join(dir, 'stubborn.log'), readyMs: 20_000, stopMs: 1_000 }), /after Ctrl\+C/);
  const silent = { script: 'sleep 30', url: `http://127.0.0.1:${await freePort()}/` };
  await assert.rejects(runServerStep(silent, state, { logFile: path.join(dir, 'silent.log'), readyMs: 1_000, stopMs: 1_000 }), /did not answer/);
  const crashed = { script: 'node -e "process.exit(3)"', url: silent.url };
  await assert.rejects(runServerStep(crashed, state, { logFile: path.join(dir, 'crashed.log'), readyMs: 20_000, stopMs: 1_000 }), /stopped before it answered at http:\/\/127\.0\.0\.1:\d+\/ \(exit 3\)/);
});

test('walk clones the commit under test into FLUJO/, follows a guide end to end and cleans up', posixOnly, async (t) => {
  const source = tempDir(t, 'flujo-guide-source-');
  const reports = path.join(tempDir(t, 'flujo-guide-reports-'), 'report');
  const port = await freePort();
  mkdirSync(path.join(source, 'docs/contributing'), { recursive: true });
  writeFileSync(path.join(source, 'server.mjs'), SERVER);
  writeFileSync(path.join(source, 'check.mjs'), "import { existsSync } from 'node:fs';\nif (!process.argv.slice(2).every((file) => existsSync(file))) process.exit(1);\n");
  writeFileSync(path.join(source, GUIDE), [
    '# Contributing', '', '## 1. Get your own copy', '', `${fence}sh`, 'git clone https://github.com/YOUR-NAME/FLUJO.git', 'cd FLUJO', 'git switch -c my-first-change', fence, '',
    '## 2. Try it', '', `${fence}sh`, 'export FLUJO_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flujo-contributor.XXXXXX")"', `node server.mjs ${port}`, fence, '',
    `Open \`http://127.0.0.1:${port}\` and stop with Ctrl+C.`, '',
    '## 3. Check', '', '| You changed | Run |', '| --- | --- |', '| Code | `node check.mjs <test files> <files>` |', '',
  ].join('\n'));
  mkdirSync(path.join(source, '__tests__/scripts'), { recursive: true });
  writeFileSync(path.join(source, '__tests__/scripts/localTestDependencies.test.ts'), '');
  mkdirSync(path.join(source, 'scripts'));
  writeFileSync(path.join(source, 'scripts/contributor-guide.mjs'), '');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '--initial-branch=main');
  git('add', '.');
  git('-c', 'user.name=FLUJO guide fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'guide');
  const tempBefore = readdirSync(os.tmpdir()).filter((name) => /^flujo-(?:guide-|contributor)/.test(name));
  const report = await walk({ source, reportDir: reports, echo: null });
  assert.equal(report.result, 'passed', report.error);
  assert.equal(report.commit, git('rev-parse', 'HEAD'));
  assert.deepEqual(report.steps.map((step) => [step.kind, step.result]), [['shell', 'passed'], ['shell', 'passed'], ['server', 'passed'], ['shell', 'passed']]);
  assert.ok(existsSync(path.join(reports, 'report.json')) && existsSync(path.join(reports, 'summary.md')));
  assert.match(readFileSync(path.join(reports, 'summary.md'), 'utf8'), /Every step of the guide worked/);
  const tempAfter = readdirSync(os.tmpdir()).filter((name) => /^flujo-(?:guide-|contributor)/.test(name));
  assert.deepEqual(tempAfter.filter((name) => !tempBefore.includes(name) && !reports.includes(name)), [], 'the clone and the data folder are removed');
  assert.ok(existsSync(path.join(source, GUIDE)), 'the checkout under test is left alone');

  writeFileSync(path.join(source, GUIDE), readFileSync(path.join(source, GUIDE), 'utf8').replace('cd FLUJO', 'cd FLUJO\nfalse'));
  git('-c', 'user.name=FLUJO guide fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'broken guide');
  const failed = await walk({ source, reportDir: reports, echo: null });
  assert.equal(failed.result, 'failed');
  assert.match(failed.error, /"git clone https:\/\/github\.com\/YOUR-NAME\/FLUJO\.git" in "1\. Get your own copy" \(docs\/contributing\/README\.md:5\) failed \(exit 1\)/);
  assert.deepEqual(failed.steps.map((step) => step.result), ['failed']);

  writeFileSync(path.join(source, GUIDE), readFileSync(path.join(source, GUIDE), 'utf8').replace('cd FLUJO\nfalse', 'cd FLUJO\necho stray > stray.txt'));
  git('-c', 'user.name=FLUJO guide fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'guide that edits a file');
  const dirty = await walk({ source, reportDir: reports, echo: null });
  assert.equal(dirty.result, 'failed');
  assert.match(dirty.error, /changed files the reader never touched[\s\S]*stray\.txt/);
  assert.ok(dirty.steps.every((step) => step.result === 'passed'), 'every step ran; only the leftover change failed the walk');
});
