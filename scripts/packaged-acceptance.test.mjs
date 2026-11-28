// Unit and real-process tests for the packaged-artifact acceptance harness.
// Real FLUJO builds, installers and images are exercised only in CI; here a
// small fixture app (scripts/fixtures/packaged-acceptance-app.mjs) stands in.
// The volume, stand-in and operator-runbook modules have their own test files.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadJSZip, parseOptions } from './packaged-acceptance.mjs';
import { CHECKS, isTransient, planChecks, runAcceptance, untilRecovered } from './packaged-acceptance/checks.mjs';
import { AnswerError, assertChangeOutcome, assertSameData, assertScheduleRuns, changeValues, semanticView } from './packaged-acceptance/flujo-probe.mjs';
import { STAND_IN_MODEL_KEY, startStandIns } from './packaged-acceptance/stand-ins.mjs';
import {
  assertContainerIdentity, assertHostIdentity, createDockerTarget, createHostTarget, hostEnvironment, hostLaunch,
  installNpmPackages, isImageReference, npmCliCandidates, portOpen, readCandidateTarballs, unusedPort, waitFor,
} from './packaged-acceptance/targets.mjs';
import { syntheticState } from './maintainer-synthetic-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'scripts', 'fixtures', 'packaged-acceptance-app.mjs');
const abs = (...parts) => path.resolve(os.tmpdir(), ...parts);

async function sandbox(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'flujo-packaged-acceptance-test-')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  for (const name of ['data', 'logs', 'app']) await mkdir(path.join(directory, name));
  return directory;
}

const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function fixtureTarget(directory, port, { label = 'release under test', mode = '', version = '1', helper = false, stopGraceMs = 30_000, appRoot } = {}) {
  const dataDir = path.join(directory, 'data');
  const cwd = path.join(directory, 'app');
  const args = [fixture, '--port', String(port), '--data', dataDir, '--full-marker', path.join(directory, 'disk-full')];
  if (helper) args.push('--helper-pid-file', path.join(directory, `${label}-helper.pid`));
  return createHostTarget({
    label, launch: { file: process.execPath, args }, cwd, port, stopGraceMs,
    env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_VERSION: version },
    logDirectory: path.join(directory, 'logs'),
    identity: observed => assertHostIdentity(observed, { appRoot: appRoot ?? cwd, dataDir }),
  });
}

/** The fixture's "disk" is full while its marker file exists. */
function fakeVolume(directory) {
  const marker = path.join(directory, 'disk-full');
  return {
    description: 'fixture volume',
    fill: async () => { await writeFile(marker, ''); return { fillerBytes: 1 }; },
    free: () => rm(marker, { force: true }),
  };
}

const json = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const kvItems = ['theme', 'title'];
const keyValueProbe = {
  async ready(request) { if ((await request('/api/init')).status !== 200) throw new Error('not ready'); },
  async observe(request) {
    const records = JSON.parse((await request('/kv')).bytes);
    delete records.schedule;
    delete records.runs;
    return records;
  },
  async seed(request) {
    await request('/kv', json({ theme: 'dark', title: 'original' }));
    return keyValueProbe.observe(request);
  },
  async backup(request, expected) {
    const response = await request('/backup');
    if (response.status !== 200) throw new AnswerError(`backup answered ${response.status}`, response.status);
    assert.deepEqual(JSON.parse(response.bytes), expected);
    return response.bytes;
  },
  async change(request, _current, { variant = 'changed', items = kvItems } = {}) {
    const response = await request('/kv?stage=change', json(Object.fromEntries(items.map(item => [item, `${variant} ${item}`]))));
    if (response.status !== 200) throw new AnswerError(`change answered ${response.status}`, response.status);
    return keyValueProbe.observe(request);
  },
  async attemptChange(request, _current, variant) {
    const values = Object.fromEntries(kvItems.map(item => [item, `${variant} ${item}`]));
    const results = [];
    for (const item of kvItems) {
      let status;
      try { status = (await request('/kv', json({ [item]: values[item] }))).status; } catch { status = 0; }
      results.push({ item, status });
    }
    return { values, results };
  },
  assertChangeOutcome(observed, before, attempt) {
    const confirmed = []; const refused = [];
    for (const { item, status } of attempt.results) {
      const ok = status === 200;
      (ok ? confirmed : refused).push(item);
      if (ok && observed[item] !== attempt.values[item]) throw new Error(`confirmed ${item} but lost it`);
      if (![attempt.values[item], before[item]].includes(observed[item])) throw new Error(`${item} is neither the old nor the new value`);
    }
    return { confirmed, refused };
  },
  expectedAfterRestore: backup => backup,
  async damagedBackups() { return [{ name: 'damaged.json', bytes: Buffer.from('{"damaged":true}') }]; },
  async restore(request, bytes) { return (await request('/restore', { method: 'POST', body: bytes })).status; },
  assertSame(observed, expected, { strict }) {
    const view = value => strict ? value : { theme: value.theme, title: value.title };
    assert.deepEqual(view(observed), view(expected));
  },
  async startBackups(request) {
    const pending = request.open('/backup?slow=1');
    await new Promise(resolve => setTimeout(resolve, 300));
    return { kinds: ['ordinary'], settle() { pending.abort(); return { ordinary: 'cut off by the stop' }; } };
  },
  async completeBackups(request, _access, expected) { return { ordinaryBytes: (await keyValueProbe.backup(request, expected)).length }; },
  async prepareAutomation(request, standIns) {
    await request('/automation', json({ modelUrl: standIns.modelUrl, key: STAND_IN_MODEL_KEY, intervalMs: 300 }));
    await waitFor(() => standIns.requestsFor('schedule').length > 0, { deadlineMs: 10_000, message: 'no fixture schedule run' });
    return {};
  },
  async verifyAutomation(request, _automation, _standIns, { restartedAt }) {
    const { runs = [] } = JSON.parse((await request('/kv')).bytes);
    if (!runs.some(at => Date.parse(at) >= restartedAt)) throw new Error('no fixture schedule run recorded after the restart');
    return { runs: runs.length };
  },
};
const quickPause = milliseconds => new Promise(resolve => setTimeout(resolve, Math.min(milliseconds, 100)));
const quickTiming = { readyMs: 20_000, recoveryMs: 2_000, scheduleMs: 10_000, pause: quickPause };
const outcome = report => Object.fromEntries(report.checks.map(check => [check.id, check.result]));

/** Run every check against fixture targets with a fake volume and real stand-ins. */
async function acceptance(t, directory, { candidate, previous }) {
  const standIns = await startStandIns();
  t.after(() => standIns.close());
  return runAcceptance({ candidate, previous, probe: keyValueProbe, volume: fakeVolume(directory), standIns, timing: quickTiming });
}

test('options name exactly one artifact for each shipped form', () => {
  assert.deepEqual(parseOptions(['--form', 'npm', '--pack', '--from', 'npm:latest']),
    { form: 'npm', keep: false, report: undefined, node: undefined, pack: true, tarballs: undefined, from: { kind: 'npm', value: 'latest' } });
  assert.equal(parseOptions(['--form', 'npm', '--tarballs', abs('release')]).tarballs, abs('release'));
  assert.equal(parseOptions(['--form', 'checkout', '--app-root', abs('FLUJO fresh install'), '--from', 'npm:3.48.10']).from.value, '3.48.10');
  assert.equal(parseOptions(['--form', 'docker', '--image', `sha256:${'a'.repeat(64)}`, '--from', 'image:ghcr.io/mario-andreschak/flujo:latest']).from.kind, 'image');
  assert.deepEqual(parseOptions(['--help']), { help: true });
  for (const bad of [
    [], ['--form', 'zip'], ['--form', 'npm'], ['--form', 'npm', '--pack', '--tarballs', abs('x')],
    ['--form', 'npm', '--tarballs', 'relative'], ['--form', 'checkout'], ['--form', 'checkout', '--app-root', 'relative'],
    ['--form', 'docker'], ['--form', 'docker', '--image', 'Bad Image'], ['--form', 'docker', '--image', 'flujo', '--from', 'npm:latest'],
    ['--form', 'npm', '--pack', '--from', 'image:flujo'], ['--form', 'npm', '--pack', '--from', 'npm:^3'],
    ['--form', 'docker', '--image', 'flujo', '--node', abs('node')], ['--form', 'checkout', '--app-root', abs('a'), '--image', 'flujo'],
    ['--form', 'npm', '--pack', '--report', 'report.json'], ['--form', 'npm', '--pack', 'stray'], ['--form', 'npm', '--pack', '--unknown'],
  ]) assert.throws(() => parseOptions(bad), /Usage:/, JSON.stringify(bad));
});

test('the plan adds the upgrade check only when a previous release is given, and every check has a title', () => {
  assert.deepEqual(planChecks({ upgrade: false }), ['start', 'seed-and-backup', 'restart-after-stop', 'restart-after-crash',
    'damaged-backup-refused', 'restore', 'backup-after-restore', 'kill-during-backup', 'disk-full', 'schedules-and-approvals', 'clean-stop']);
  assert.deepEqual(planChecks({ upgrade: true }).slice(0, 3), ['previous-start', 'seed-and-backup', 'upgrade']);
  for (const id of planChecks({ upgrade: true })) assert.equal(typeof CHECKS[id], 'string', id);
});

test('only missing answers, server errors and timeouts are retried while an app recovers', async () => {
  for (const transient of [new AnswerError('x', 0), new AnswerError('x', 503), Object.assign(new Error('x'), { status: 500 }),
    Object.assign(new Error('x'), { name: 'TimeoutError' }), new TypeError('fetch failed')]) assert.equal(isTransient(transient), true, transient.message);
  for (const lasting of [new AnswerError('x', 423), new AnswerError('x', 400), new Error('The app confirmed the changes but does not show them.'), new TypeError('x is not a function')]) {
    assert.equal(isTransient(lasting), false, lasting.message);
  }
  let calls = 0;
  assert.equal(await untilRecovered(async () => { if (++calls < 3) throw new AnswerError('busy', 507); return 'ok'; }, { deadlineMs: 5_000, pause: async () => {} }), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(untilRecovered(async () => { calls++; throw new AnswerError('locked', 423); }, { deadlineMs: 5_000, pause: async () => {} }), /locked/);
  assert.equal(calls, 1, 'a 4xx answer is never retried');
  await assert.rejects(untilRecovered(async () => { throw new AnswerError('still full', 507); }, { deadlineMs: 50, intervalMs: 10 }), /still full/);
});

test('npm is found next to official Node.js downloads on each platform', () => {
  assert.deepEqual(npmCliCandidates({ execPath: 'C:\\node\\node.exe', platform: 'win32', env: {} }),
    ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js']);
  assert.deepEqual(npmCliCandidates({ execPath: '/opt/node/bin/node', platform: 'linux', env: {} }),
    ['/opt/node/lib/node_modules/npm/bin/npm-cli.js']);
  assert.equal(npmCliCandidates({ execPath: '/x/node', platform: 'linux', env: { npm_execpath: '/y/npm-cli.js' } })[0], '/y/npm-cli.js');
});

test('each host form starts the way its own launcher does', () => {
  const app = abs('app');
  assert.deepEqual(hostLaunch({ form: 'npm', appRoot: app, port: 4321, node: '/node' }),
    { file: '/node', args: [path.join(app, 'bin', 'flujo.mjs'), '--no-open', '--port', '4321'] });
  assert.deepEqual(hostLaunch({ form: 'checkout', appRoot: app, port: 4321, node: '/node' }),
    { file: '/node', args: [path.join(app, 'scripts', 'launch-next.mjs'), 'start', '-p', '4321'] });
  assert.throws(() => hostLaunch({ form: 'docker', appRoot: app, port: 1 }), /Unknown host form/);
});

test('the app environment is private and keeps only what starting programs needs', () => {
  const env = hostEnvironment({ sandbox: abs('box'), dataDir: abs('box', 'data'), sandboxPort: 5000, node: abs('rt', 'node.exe'), snapshotToken: 't'.repeat(43),
    inherited: { PATH: 'base', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--max-old-space-size=1', FLUJO_OWNER_AUTH_FILE: 'x', GITHUB_TOKEN: 't', FLUJO_SNAPSHOT_CONTROL_TOKEN: 'inherited' } });
  assert.equal(env.PATH, [abs('rt'), 'base'].join(path.delimiter));
  assert.equal(env.SystemRoot, 'C:\\Windows');
  for (const name of ['OPENAI_API_KEY', 'NODE_OPTIONS', 'FLUJO_OWNER_AUTH_FILE', 'GITHUB_TOKEN']) assert.equal(env[name], undefined, name);
  assert.equal(env.FLUJO_DATA_DIR, abs('box', 'data'));
  assert.equal(env.HOME, abs('box', 'home'));
  assert.equal(env.FLUJO_MCP_APP_SANDBOX_PORT, '5000');
  assert.equal(env.FLUJO_EXPOSURE_MODE, 'localhost');
  assert.equal(env.FLUJO_SNAPSHOT_CONTROL_TOKEN, 't'.repeat(43), 'the run picks its own snapshot token; an inherited one never leaks in');
  assert.equal(hostEnvironment({ sandbox: abs('box'), dataDir: abs('d'), sandboxPort: 1, inherited: {} }).FLUJO_SNAPSHOT_CONTROL_TOKEN, undefined);
});

test('only the process started on its own data folder may be changed', () => {
  const identity = { appRoot: 'C:\\Users\\Runner\\FLUJO fresh install', dataDir: 'C:\\Temp\\box\\data', platform: 'win32' };
  assertHostIdentity({ cwd: 'c:\\users\\runner\\flujo fresh install', mcpServersDir: 'C:\\Temp\\BOX\\data\\workspaces\\default\\mcp-servers' }, identity);
  assert.throws(() => assertHostIdentity({ cwd: 'C:\\other', mcpServersDir: 'C:\\Temp\\box\\data\\x' }, identity), /Another program/);
  assert.throws(() => assertHostIdentity({ cwd: identity.appRoot, mcpServersDir: 'C:\\Users\\Runner\\.flujo\\x' }, identity), /outside the test data folder/);
  assert.throws(() => assertHostIdentity({ cwd: '/app', mcpServersDir: '/data/x' }, { appRoot: '/App', dataDir: '/data', platform: 'linux' }), /Another program/);
  assertContainerIdentity({ cwd: '/app', mcpServersDir: '/app/data/workspaces/default/mcp-servers' });
  assert.throws(() => assertContainerIdentity({ cwd: '/app', mcpServersDir: '/tmp/x' }), /\/app\/data/);
});

test('image references and IDs are recognised, anything else is refused', () => {
  for (const good of [`sha256:${'b'.repeat(64)}`, 'ghcr.io/mario-andreschak/flujo:latest', 'flujo-process-boundary-smoke:abc123', `ghcr.io/x/y@sha256:${'c'.repeat(64)}`]) assert.ok(isImageReference(good), good);
  for (const bad of ['', 'UPPER/case', 'a b', '-flag', `sha256:${'z'.repeat(64)}`, undefined]) assert.equal(isImageReference(bad), false, String(bad));
});

test('a release candidate folder installs exactly the tarballs its manifest lists', async t => {
  const directory = await sandbox(t);
  const write = manifest => writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'flujo-ai-1.0.0.tgz'), 'x');
  await writeFile(path.join(directory, 'mario.andreschak-mcp-bash-1.0.0.tgz'), 'x');
  await write({ version: '1.0.0', revision: 'r', packages: [{ name: '@mario.andreschak/mcp-bash', filename: 'mario.andreschak-mcp-bash-1.0.0.tgz' }, { name: 'flujo-ai', filename: 'flujo-ai-1.0.0.tgz' }] });
  const read = await readCandidateTarballs(directory);
  assert.deepEqual(read.tarballs.map(file => path.basename(file)), ['mario.andreschak-mcp-bash-1.0.0.tgz', 'flujo-ai-1.0.0.tgz']);
  await write({ packages: [{ name: '@mario.andreschak/mcp-bash', filename: 'mario.andreschak-mcp-bash-1.0.0.tgz' }] });
  await assert.rejects(readCandidateTarballs(directory), /no flujo-ai package/);
  await write({ packages: [{ name: 'flujo-ai', filename: '../escape.tgz' }] });
  await assert.rejects(readCandidateTarballs(directory), /unexpected file/);
});

test('a failed registry download is tried once more before the install fails', async t => {
  const directory = await sandbox(t);
  const consumer = path.join(directory, 'consumer');
  const calls = [];
  const run = async (_file, args, options) => {
    calls.push(args.slice(1));
    if (calls.length === 1) throw new Error('ECONNRESET');
    await mkdir(path.join(options.cwd, 'node_modules', 'flujo-ai'), { recursive: true });
    await writeFile(path.join(options.cwd, 'node_modules', 'flujo-ai', 'package.json'), '{"name":"flujo-ai","version":"9.9.9"}');
  };
  const installed = await installNpmPackages({ consumer, specs: ['flujo-ai@latest'], npmCli: '/npm-cli.js', run, pause: async () => {} });
  assert.equal(installed.version, '9.9.9');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', 'flujo-ai@latest']);
  assert.equal(await readFile(path.join(consumer, 'package.json'), 'utf8'), '{"private":true}\n');
  await assert.rejects(installNpmPackages({ consumer, specs: ['x'], npmCli: '/n', attempts: 2, run: async () => { throw new Error('offline'); }, pause: async () => {} }), /offline/);
});

test('containers restart in place on the small volume, reach the stand-ins and report a stop that needed SIGKILL', async () => {
  const calls = [];
  let exitCode = '143';
  let pulls = 0;
  const docker = async args => {
    calls.push(args.join(' '));
    if (args[0] === 'pull' && ++pulls === 1) throw new Error('registry hiccup');
    if (args[0] === 'image') return 'sha256:feed\n';
    if (args[0] === 'inspect') return args[2] === '{{.State.Running}}' ? 'true\n' : `${exitCode}\n`;
    return '';
  };
  const mount = 'type=volume,src=vol,dst=/app/data,volume-subpath=data';
  const target = createDockerTarget({ label: 'previous release', image: 'ghcr.io/x/flujo:latest', name: 'box', mount, port: 1, docker, pause: async () => {} });
  await target.prepare();
  assert.equal(target.imageId, 'sha256:feed');
  assert.equal(target.snapshotToken, undefined, 'a container accepts snapshot backups only from inside');
  await target.start();
  assert.ok(await target.running());
  const stopped = await target.stop();
  assert.equal(stopped.graceful, true);
  await target.start();
  exitCode = '137';
  assert.equal((await target.stop()).graceful, false);
  await target.kill();
  await target.remove();
  await target.dispose();
  assert.deepEqual(calls, [
    'pull ghcr.io/x/flujo:latest', 'pull ghcr.io/x/flujo:latest', 'image inspect --format {{.Id}} ghcr.io/x/flujo:latest',
    `run --detach --name box --label io.flujo.packaged-acceptance=previous release --publish 127.0.0.1:1:4200 --mount ${mount} --add-host flujo-acceptance-host:host-gateway sha256:feed`,
    'inspect --format {{.State.Running}} box',
    'stop --time 30 box', 'inspect --format {{.State.ExitCode}} box',
    'start box',
    'stop --time 30 box', 'inspect --format {{.State.ExitCode}} box',
    'kill box', 'inspect --format {{.State.ExitCode}} box',
    'rm --force box',
  ]);
});

function observation() {
  const fixtureState = syntheticState();
  const { id, ...record } = structuredClone(fixtureState.conversation);
  const conversationArchive = { ...record, conversationId: id, updatedAt: record.createdAt, source: 'chat',
    trackingInfo: { executionId: 'exec-1', startTime: 1, nodeExecutionTracker: [] } };
  const conversation = { id, ...structuredClone(record), updatedAt: record.createdAt, parentConversationId: null, rootConversationId: null,
    transcriptWindow: { truncated: false, loadedCount: 2, totalCount: 2, source: 'snapshot' } };
  return {
    state: { theme: fixtureState.theme, environment: structuredClone(fixtureState.environment), conversation, conversationArchive },
    flows: [{ id: 'maintainer_drill_flow', name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] },
      { id: 'default-agent-flujo', name: 'FLUJO', nodes: [{ id: 'n' }], edges: [] }],
  };
}

test('strict comparison catches any stored difference; the upgrade view compares what a user sees', () => {
  assertSameData(observation(), observation(), { strict: true });
  const view = semanticView(observation());
  assert.equal(view.conversation.messages.length, 2);
  assert.equal(view.flow.name, 'Synthetic maintainer recovery fixture');
  const newer = observation();
  newer.state.conversation.addedByNewerRelease = true;
  newer.flows[0].addedByNewerRelease = true;
  assertSameData(newer, observation(), { strict: false });
  const lost = observation();
  lost.state.conversation.messages.pop();
  assert.throws(() => assertSameData(lost, observation(), { strict: false }), /differs/);
  const renamed = observation();
  renamed.flows[0].name = 'other';
  assert.throws(() => assertSameData(renamed, observation(), { strict: false }), /differs/);
  assert.throws(() => assertSameData(newer, observation(), { strict: true }), /Synthetic conversation/);
  const reseeded = observation();
  reseeded.flows[1].nodes = [];
  assertSameData(reseeded, observation(), { strict: false });
  assert.throws(() => assertSameData(reseeded, observation(), { strict: true }), /Flow inventory/);
});

test('every change picks values different from what is shown', () => {
  const values = changeValues(semanticView(observation()), 'Variant');
  assert.deepEqual(values, { theme: 'light', setting: 'Variant setting', title: 'Variant conversation', flowName: 'Variant flow' });
  for (const variant of ['Changed before a forced stop', 'Changed after a stop during a backup', 'Changed while the disk was full', 'Changed after the disk was freed']) {
    assert.match(changeValues({ theme: 'dark' }, variant).flowName, /^[\p{L}\p{N}_ -]{1,160}$/u, 'a valid FLUJO flow name');
  }
  assert.equal(changeValues({ theme: 'light' }, 'x').theme, 'dark');
});

test('after a full disk, confirmed changes must be shown and nothing else may change or break', () => {
  const before = observation();
  const values = changeValues(semanticView(before), 'Full');
  const after = ({ theme = before.state.theme, title = before.state.conversation.title, flowName = before.flows[0].name, setting = before.state.environment.value } = {}) => {
    const shown = observation();
    shown.state.theme = theme; shown.state.conversation.title = title; shown.flows[0].name = flowName; shown.state.environment.value = setting;
    return shown;
  };
  const attempt = statuses => ({ values, results: ['theme', 'setting', 'title', 'flowName'].map((item, index) => ({ item, status: statuses[index] })) });
  assert.deepEqual(assertChangeOutcome(after({ theme: values.theme }), before, attempt([200, 507, 500, 0])),
    { confirmed: ['theme'], refused: ['setting', 'title', 'flowName'] });
  assert.deepEqual(assertChangeOutcome(after({ title: values.title }), before, attempt([507, 507, 507, 507])).refused.length, 4,
    'a refused change may still show up later, as long as it is complete');
  assert.throws(() => assertChangeOutcome(after(), before, attempt([200, 507, 507, 507])), /confirmed the theme change .* but lost it/);
  assert.throws(() => assertChangeOutcome(after({ flowName: '' }), before, attempt([507, 507, 507, 507])), /flow name shows "", neither/);
  const otherDamage = after();
  otherDamage.state.conversation.messages.pop();
  assert.throws(() => assertChangeOutcome(otherDamage, before, attempt([507, 507, 507, 507])), /never changed differs/);
});

test('schedule runs and model calls match one to one across a forced restart', () => {
  const at = seconds => new Date(Date.UTC(2026, 10, 27, 12, 0, seconds)).toISOString();
  const killedAt = Date.parse(at(12)); const restartedAt = Date.parse(at(20));
  const run = (seconds, status = 'completed') => ({ firedAt: at(seconds), status });
  const call = seconds => ({ firedAt: at(seconds) });
  const base = { killedAt, restartedAt, intervalMs: 5_000 };
  assert.deepEqual(assertScheduleRuns({ ...base, runs: [run(5), run(10), run(25)], requests: [call(5), call(10), call(25)] }),
    { runsBefore: 2, runsAfter: 1, modelCalls: 3, unrecordedRunAtKill: false });
  assert.equal(assertScheduleRuns({ ...base, runs: [run(5), run(25)], requests: [call(5), call(10), call(25)] }).unrecordedRunAtKill, true,
    'the run under way at the kill may be missing from the history');
  assert.throws(() => assertScheduleRuns({ ...base, runs: [run(5), run(25)], requests: [call(5), call(25), call(25)] }), /called the model 2 times/);
  assert.throws(() => assertScheduleRuns({ ...base, runs: [run(5)], requests: [call(5), call(30)] }), /not in the run history/);
  assert.throws(() => assertScheduleRuns({ ...base, runs: [run(5), run(10), run(25)], requests: [call(10), call(25)] }), /never called the model/);
  assert.throws(() => assertScheduleRuns({ ...base, runs: [run(5), run(25), { firedAt: new Date(Date.parse(at(25)) + 400).toISOString(), status: 'skipped' }],
    requests: [call(5), call(25)] }), /ran twice for the occurrence/);
  assert.throws(() => assertScheduleRuns({ ...base, runs: [run(25)], requests: [call(25)] }), /no recorded run from before/);
  assert.throws(() => assertScheduleRuns({ ...base, runs: [run(5)], requests: [call(5)] }), /no recorded run from after/);
  assert.throws(() => assertScheduleRuns({ ...base, runs: [run(5), run(15, 'skipped'), run(25)], requests: [call(5), call(25)] }), /while the app was stopped/);
  assert.throws(() => assertScheduleRuns({ ...base, runs: [run(5), run(25)], requests: [call(5), { firedAt: null }] }), /no fire time/);
});

test('jszip comes from this checkout or from the installed app', () => {
  assert.equal(typeof loadJSZip([path.join(os.tmpdir(), 'no-such-folder'), root]).loadAsync, 'function');
  assert.throws(() => loadJSZip([path.join(os.tmpdir(), 'no-such-folder')]), /jszip was not found/);
});

test('a faithful app passes every check with real processes, and nothing keeps running', async t => {
  const directory = await sandbox(t);
  const port = await unusedPort();
  const report = await acceptance(t, directory, { candidate: fixtureTarget(directory, port, { helper: true }) });
  assert.equal(report.result, 'passed', JSON.stringify(report, null, 2));
  assert.ok(report.checks.every(check => check.result === 'passed'));
  assert.deepEqual(report.stops.map(stop => stop.kind), ['stop', 'kill', 'kill', 'kill', 'kill', 'stop']);
  assert.ok(report.stops.every(stop => stop.portClosed));
  assert.deepEqual(report.checks.find(check => check.id === 'kill-during-backup').details.interrupted, { ordinary: 'cut off by the stop' });
  assert.deepEqual(report.checks.find(check => check.id === 'disk-full').details, { volume: 'fixture volume', fillerBytes: 1, confirmed: [], refused: ['theme', 'title'] });
  if (process.platform !== 'win32') {
    assert.ok(report.stops.filter(stop => stop.kind === 'stop').every(stop => stop.graceful && stop.leftoverHelpers === false));
  }
  assert.equal(await portOpen(port), false);
  const helper = Number(await readFile(path.join(directory, 'release under test-helper.pid'), 'utf8'));
  for (let attempt = 0; attempt < 50 && pidAlive(helper); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(pidAlive(helper), false, 'helper processes end with the app');
});

test('a change that a crash loses fails the crash check and skips the rest', async t => {
  const directory = await sandbox(t);
  const port = await unusedPort();
  const report = await acceptance(t, directory, { candidate: fixtureTarget(directory, port, { mode: 'memory-only-changes' }) });
  assert.equal(report.result, 'failed');
  assert.deepEqual(outcome(report), { start: 'passed', 'seed-and-backup': 'passed', 'restart-after-stop': 'passed', 'restart-after-crash': 'failed',
    'damaged-backup-refused': 'not-run', restore: 'not-run', 'backup-after-restore': 'not-run', 'kill-during-backup': 'not-run',
    'disk-full': 'not-run', 'schedules-and-approvals': 'not-run', 'clean-stop': 'not-run' });
  assert.equal(await portOpen(port), false, 'a failed run still stops the app');
});

test('accepting a damaged backup fails the check', async t => {
  const directory = await sandbox(t);
  const report = await acceptance(t, directory, { candidate: fixtureTarget(directory, await unusedPort(), { mode: 'accept-damaged' }) });
  assert.equal(outcome(report)['damaged-backup-refused'], 'failed');
  assert.match(report.failure, /damaged\.json was answered with 200/);
});

test('a backup lock that outlives a forced stop fails the backup check', async t => {
  const directory = await sandbox(t);
  const report = await acceptance(t, directory, { candidate: fixtureTarget(directory, await unusedPort(), { mode: 'backup-lock' }) });
  assert.equal(outcome(report)['kill-during-backup'], 'failed');
  assert.match(report.failure, /backup answered 423/);
  assert.equal(outcome(report)['disk-full'], 'not-run');
});

for (const [mode, message] of [
  ['crash-when-full', /stopped (answering )?when the disk was full/],
  ['lie-when-full', /confirmed theme but lost it/],
  ['corrupt-when-full', /theme is neither the old nor the new value/],
  ['stuck-after-full', /change answered 507/],
]) {
  test(`an app that ${mode.replaceAll('-', ' ')} fails the disk-full check, and the disk is freed again`, async t => {
    const directory = await sandbox(t);
    const port = await unusedPort();
    const report = await acceptance(t, directory, { candidate: fixtureTarget(directory, port, { mode }) });
    assert.equal(outcome(report)['kill-during-backup'], 'passed');
    assert.equal(outcome(report)['disk-full'], 'failed');
    assert.match(report.failure, message);
    await assert.rejects(readFile(path.join(directory, 'disk-full')), { code: 'ENOENT' });
    assert.equal(await portOpen(port), false);
  });
}

test('a schedule that does not start again after a restart fails the schedule check', async t => {
  const directory = await sandbox(t);
  const report = await acceptance(t, directory, { candidate: fixtureTarget(directory, await unusedPort(), { mode: 'forget-schedules' }) });
  assert.equal(outcome(report)['disk-full'], 'passed');
  assert.equal(outcome(report)['schedules-and-approvals'], 'failed');
  assert.match(report.failure, /schedule did not run within 10 s of a restart that nobody followed/);
});

test('an upgrade keeps data written by the previous release and restores its backup', async t => {
  const directory = await sandbox(t);
  const port = await unusedPort();
  const previous = fixtureTarget(directory, port, { label: 'previous release', version: '1' });
  const candidate = fixtureTarget(directory, port, { version: '2' });
  const report = await acceptance(t, directory, { candidate, previous });
  assert.equal(report.result, 'passed', JSON.stringify(report, null, 2));
  assert.equal(report.checks[2].id, 'upgrade');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'data', 'records.json'), 'utf8')).writtenBy, '1');
});

test('a release that ignores older data fails the upgrade check', async t => {
  const directory = await sandbox(t);
  const port = await unusedPort();
  const previous = fixtureTarget(directory, port, { label: 'previous release', version: '1' });
  const candidate = fixtureTarget(directory, port, { version: '2', mode: 'ignore-old-data' });
  const report = await acceptance(t, directory, { candidate, previous });
  assert.equal(outcome(report).upgrade, 'failed');
  assert.equal(await portOpen(port), false);
});

test('an app that exits while starting is reported with its own output', async t => {
  const directory = await sandbox(t);
  const report = await acceptance(t, directory, { candidate: fixtureTarget(directory, await unusedPort(), { mode: 'exit-early' }) });
  assert.equal(outcome(report).start, 'failed');
  assert.match(report.failure, /stopped before it was ready[\s\S]*boom/);
});

test('a different program on the port is never changed', async t => {
  const directory = await sandbox(t);
  const report = await acceptance(t, directory, { candidate: fixtureTarget(directory, await unusedPort(), { appRoot: path.join(directory, 'elsewhere') }) });
  assert.equal(outcome(report).start, 'failed');
  assert.match(report.failure, /Another program answered/);
  assert.equal(outcome(report)['seed-and-backup'], 'not-run');
});

test('an app that ignores a normal stop request fails, and is then ended', { skip: process.platform === 'win32' && 'Windows has no gentle stop signal for console programs' }, async t => {
  const directory = await sandbox(t);
  const port = await unusedPort();
  const report = await acceptance(t, directory, { candidate: fixtureTarget(directory, port, { mode: 'ignore-stop', stopGraceMs: 1_000 }) });
  assert.equal(outcome(report)['restart-after-stop'], 'failed');
  assert.match(report.failure, /did not stop on its own/);
  assert.equal(await portOpen(port), false);
});
