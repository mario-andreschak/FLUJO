import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, link, copyFile, symlink, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import terminal from './terminal-fixture.cjs';

test('terminal-only environment runs real shell commands and does not mistake HTTP claims for browser execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flujo-goal-terminal-'));
  let server;
  try {
    const facts = await terminal.createFixture(directory, 0);
    server = await terminal.startResearchServer(directory);
    const { baseUrl } = JSON.parse(await readFile(path.join(directory, 'http-environment.json'), 'utf8'));
    const result = await terminal.executeTerminal(directory, { command: 'node -e "console.log(process.version)"', timeoutMs: 10000 });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.match(JSON.parse(result.content[0].text).stdout, /v\d+\./);
    const page = await (await fetch(`${baseUrl}/research`)).text();
    assert.ok(page.includes(facts.sourceId));
    await fetch(`${baseUrl}/browser-observed`, { method: 'POST', headers: { 'user-agent': 'Chrome claims alone are insufficient' }, body: facts.sourceId });
    const evidence = await terminal.verifyFixture(directory);
    assert.equal(evidence.browserExecutionVerified, false);
    assert.equal(evidence.environmentBootstrapVerified, false);
    assert.equal(evidence.terminalCommands.length, 1);
    await writeFile(path.join(directory, 'inspect-environment.cjs'), `process.stdout.write(JSON.stringify({ root: process.env.FLUJO_GOAL_FIXTURE_ROOT, temp: process.env.TEMP, npm: process.env.npm_config_cache, node: process.env.NODE_COMPILE_CACHE, cache: process.env.XDG_CACHE_HOME }));`);
    const environmentResult = await terminal.executeTerminal(directory, { command: 'node inspect-environment.cjs', timeoutMs: 10000 });
    assert.equal(environmentResult.isError, undefined, environmentResult.content[0].text);
    const environment = JSON.parse(JSON.parse(environmentResult.content[0].text).stdout);
    assert.equal(environment.root, directory);
    for (const localPath of [environment.temp, environment.npm, environment.node, environment.cache]) {
      assert.ok(path.relative(directory, localPath) && !path.relative(directory, localPath).startsWith('..'));
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('terminal bootstrap rejects any preexisting fixture content, including an alternate browser location', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flujo-goal-existing-'));
  try {
    await mkdir(path.join(directory, 'already-installed-browser'));
    await assert.rejects(terminal.createFixture(directory), /initially empty fixture directory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A Chromium-named Node executable is used only to test launch instrumentation
// and path validation. The synthetic DOM record below is not live acceptance
// evidence and these unit tests do not claim to install or execute Chromium.
for (const scenario of ['alternate-local', 'changed-environment', 'outside-fixture', 'symlink-escape']) {
  test(`observer and independent containment verifier: ${scenario}`, async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'flujo-goal-observer-'));
    const directory = path.join(parent, 'fixture');
    const outside = path.join(parent, 'outside');
    const browserDirectory = ['outside-fixture', 'symlink-escape'].includes(scenario)
      ? outside : path.join(directory, 'campaign-browsers', 'manual-chromium');
    try {
      const facts = await terminal.createFixture(directory, 0);
      await mkdir(browserDirectory, { recursive: true });
      const executable = path.join(browserDirectory, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
      try { await link(process.execPath, executable); }
      catch { await copyFile(process.execPath, executable); }
      let selectedExecutable = executable;
      if (scenario === 'symlink-escape') {
        const symlinkDirectory = path.join(directory, 'local-looking-browser');
        await symlink(outside, symlinkDirectory, process.platform === 'win32' ? 'junction' : 'dir');
        selectedExecutable = path.join(symlinkDirectory, path.basename(executable));
      }
      const mutation = scenario === 'changed-environment'
        ? `process.env.PLAYWRIGHT_BROWSERS_PATH = ${JSON.stringify(browserDirectory)}; process.env.FLUJO_GOAL_FIXTURE_ROOT = ${JSON.stringify(outside)};`
        : '';
      await writeFile(path.join(directory, 'observer-probe.cjs'), `${mutation}\nconst child = require('node:child_process').spawn(${JSON.stringify(selectedExecutable)}, ['-e', 'process.stdout.write("instrumentation probe")'], { stdio: 'inherit' }); child.once('exit', code => { process.exitCode = code; });`);
      const result = await terminal.executeTerminal(directory, { command: 'node observer-probe.cjs', timeoutMs: 10000 });
      assert.equal(result.isError, undefined, result.content[0].text);
      const launches = (await readFile(path.join(directory, 'browser-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(launches.length, 1);
      const insideFixture = ['alternate-local', 'changed-environment'].includes(scenario);
      assert.equal(launches[0].insideFixtureDirectory, insideFixture);
      assert.equal(launches[0].fixtureRoot, directory);
      if (scenario === 'changed-environment') assert.equal(launches[0].selectedBrowserDirectory, browserDirectory);
      await appendFile(path.join(directory, 'http-audit.jsonl'), `${JSON.stringify({
        at: launches[0].at + 1, method: 'POST', url: '/browser-observed',
        userAgent: 'Chromium synthetic instrumentation unit test', body: facts.sourceId,
      })}\n`);
      // Even a forged positive observer flag cannot bless an outside executable.
      if (!insideFixture) {
        launches[0].insideFixtureDirectory = true;
        await writeFile(path.join(directory, 'browser-audit.jsonl'), `${JSON.stringify(launches[0])}\n`);
      }
      const evidence = await terminal.verifyFixture(directory);
      assert.equal(evidence.browserExecutionVerified, insideFixture);
      assert.equal(evidence.environmentBootstrapVerified, insideFixture);
      if (insideFixture) {
        const setupFile = path.join(directory, 'terminal-fixture.json');
        const setup = JSON.parse(await readFile(setupFile, 'utf8'));
        delete setup.initialEntries;
        await writeFile(setupFile, JSON.stringify(setup));
        assert.equal((await terminal.verifyFixture(directory)).environmentBootstrapVerified, false,
          'Missing initial-environment observation must not be replaced by an assumed absence.');
      }
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
}
