// Tests for the automated operator run (scripts/operator-runbook.mjs). The
// runbook page itself is parsed here on every CI run, so a missing, misordered
// or incomplete step fails before any release. The full run against real
// packages happens in verify-full.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  DEFAULT_RUNBOOK, assertDataFolder, assertNamesFailedJob, assertSameView, assertShowsVersion, operatorEnvironment, parseOptions,
  runJourney, shellCommand, verifyBackupFile,
} from './operator-runbook.mjs';
import { OPERATOR_VARIABLES, REQUIRED_STEPS, assignedVariables, parseRunbook, readSteps, referencedVariables } from './operator-runbook/parse.mjs';
import { mergePackument, packageJsonOfTarball, previousVersion, startRegistry, versionEntry } from './operator-runbook/registry.mjs';
import { runCommand } from './packaged-acceptance/targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSZip = createRequire(path.join(root, 'package.json'))('jszip');
const page = await readFile(DEFAULT_RUNBOOK, 'utf8');

test('the published runbook has every operator step, in order, for bash and PowerShell', () => {
  const steps = parseRunbook(page);
  assert.deepEqual(Object.keys(steps), REQUIRED_STEPS);
  for (const id of REQUIRED_STEPS.filter(item => item !== 'stop')) {
    assert.ok(steps[id].blocks.bash.trim() && steps[id].blocks.powershell.trim(), id);
  }
  assert.deepEqual(steps.stop.blocks, {});
});

const block = (language, text) => `\`\`\`${language}\n${text}\n\`\`\``;
const chooseBash = OPERATOR_VARIABLES.map(name => `export ${name}=x`).join('\n');
const choosePowerShell = OPERATOR_VARIABLES.map(name => `$env:${name} = 'x'`).join('\n');
function runbook(overrides = {}) {
  return REQUIRED_STEPS.map(id => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === 'stop') return '<!-- operator-step: stop -->\nPress Ctrl+C.';
    if (id === 'choose') return `<!-- operator-step: choose -->\n${block('bash', chooseBash)}\n\n${block('powershell', choosePowerShell)}`;
    return `<!-- operator-step: ${id} -->\n${block('bash', `echo "$FLUJO_PORT"`)}\n${block('powershell', 'Write-Output $env:FLUJO_PORT')}`;
  }).filter(Boolean).join('\n\n## Next\n\n');
}

test('a complete page parses; a heading ends a step and other code blocks are ignored', () => {
  assert.deepEqual(Object.keys(parseRunbook(runbook())), REQUIRED_STEPS);
  const steps = readSteps('<!-- operator-step: check -->\n```json\n{}\n```\n```BASH\nup\n```\n## Other\n```powershell\nignored\n```\r\n');
  assert.deepEqual(steps.map(step => [step.id, step.blocks]), [['check', { bash: 'up' }]]);
});

for (const [label, overrides, message] of [
  ['a missing step', { diagnose: '' }, /has no "diagnose" step/],
  ['steps out of order', { check: '', restore: `${runbook({}).split('## Next').find(part => part.includes('step: restore'))}\n\n<!-- operator-step: check -->\n${block('bash', 'x')}\n${block('powershell', 'x')}` }, /must come in this order/],
  ['an unknown step', { restore: `<!-- operator-step: rollback -->\n${block('bash', 'x')}\n${block('powershell', 'x')}` }, /"rollback" is not an operator step[\s\S]*has no "restore" step/],
  ['a step given twice', { upgrade: `<!-- operator-step: upgrade -->\n${block('bash', 'x')}\n${block('powershell', 'x')}\n\n<!-- operator-step: upgrade -->\n${block('bash', 'x')}\n${block('powershell', 'x')}` }, /"upgrade" step appears twice/],
  ['two bash blocks in one step', { start: `<!-- operator-step: start -->\n${block('bash', 'a')}\n${block('bash', 'b')}\n${block('powershell', 'x')}` }, /more than one bash block/],
  ['no Windows command', { 'back-up': `<!-- operator-step: back-up -->\n${block('bash', 'x')}` }, /"back-up" step has no powershell command/],
  ['an empty command', { restore: `<!-- operator-step: restore -->\n${block('bash', '  ')}\n${block('powershell', 'x')}` }, /"restore" step has no bash command/],
  ['a command for a step done by hand', { stop: `<!-- operator-step: stop -->\n${block('bash', 'kill 1')}` }, /done by hand; it must not hold a bash command/],
  ['a choose step that misses a setting', { choose: `<!-- operator-step: choose -->\n${block('bash', 'export FLUJO_VERSION=1')}\n${block('powershell', choosePowerShell)}` }, /bash "choose" step sets FLUJO_VERSION; it must set exactly/],
  ['a step that uses an unset setting', { check: `<!-- operator-step: check -->\n${block('bash', 'curl "$FLUJO_HOST"')}\n${block('powershell', 'Invoke-RestMethod $env:FLUJO_URL')}` }, /bash "check" step uses FLUJO_HOST[\s\S]*powershell "check" step uses FLUJO_URL/],
]) {
  test(`the runbook check refuses ${label}`, () => {
    assert.throws(() => parseRunbook(runbook(overrides)), message);
  });
}

test('settings are read the way each shell writes and reads them', () => {
  assert.deepEqual(assignedVariables('bash', 'export FLUJO_A=1\n  export FLUJO_B="x"\nFLUJO_C=2'), ['FLUJO_A', 'FLUJO_B']);
  assert.deepEqual(assignedVariables('powershell', "$env:FLUJO_A = '1'\n$FLUJO_B = 2"), ['FLUJO_A']);
  assert.deepEqual(referencedVariables('bash', 'curl "$FLUJO_A" ${FLUJO_B} $HOME $FLUJO_A'), ['FLUJO_A', 'FLUJO_B']);
  assert.deepEqual(referencedVariables('powershell', '$env:FLUJO_A $FLUJO_B $env:PATH'), ['FLUJO_A']);
});

/** A minimal npm tarball: gzip(tar) with package/package.json. */
function tarball(manifest, prefix = '') {
  const body = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(512);
  const name = 'package/package.json';
  if (prefix) { header.write(name.slice(prefix.length + 1), 0); header.write(prefix, 345); } else header.write(name, 0);
  header.write(body.length.toString(8).padStart(11, '0'), 124);
  const skipped = Buffer.alloc(512); skipped.write('package/README.md', 0); skipped.write('00000000004', 124);
  return gzipSync(Buffer.concat([skipped, Buffer.alloc(512, 'x'), header, body, Buffer.alloc(512 - body.length % 512), Buffer.alloc(1024)]));
}

test('candidate tarballs become registry versions with their own checksums', () => {
  const bytes = tarball({ name: 'flujo-ai', version: '9.9.9', dependencies: { a: '1' } });
  assert.deepEqual(packageJsonOfTarball(bytes), { name: 'flujo-ai', version: '9.9.9', dependencies: { a: '1' } });
  assert.equal(packageJsonOfTarball(tarball({ name: 'x', version: '1.0.0' }, 'package')).name, 'x', 'long names split over the ustar prefix');
  assert.throws(() => packageJsonOfTarball(gzipSync(Buffer.alloc(1024))), /no package\/package.json/);
  const entry = versionEntry({ name: 'flujo-ai', version: '9.9.9' }, Buffer.from('abc'), 'http://r/-/f.tgz');
  assert.deepEqual(entry.dist, { tarball: 'http://r/-/f.tgz', shasum: 'a9993e364706816aba3e25717850c26c9cd0d89d',
    integrity: 'sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==' });
  const known = { name: 'flujo-ai', 'dist-tags': { latest: '9.9.8' }, versions: { '9.9.8': {} }, time: { '9.9.8': 't' } };
  const merged = mergePackument(known, 'flujo-ai', [entry]);
  assert.deepEqual(Object.keys(merged.versions), ['9.9.8', '9.9.9']);
  assert.equal(merged['dist-tags'].latest, '9.9.8', 'an existing package keeps its published latest');
  assert.ok(merged.time['9.9.9']);
  assert.equal(known.versions['9.9.9'], undefined, 'the upstream document is not changed');
  assert.equal(mergePackument(undefined, 'new-pkg', [{ ...entry, name: 'new-pkg' }])['dist-tags'].latest, '9.9.9');
  assert.ok(mergePackument({ name: 'abbreviated', versions: {} }, 'abbreviated', [entry]).versions['9.9.9'], 'abbreviated documents have no time');
});

test('the operator upgrades from the newest published version older than the release under test', () => {
  const packument = { 'dist-tags': { latest: '3.48.10' }, versions: Object.fromEntries(['3.48.8', '3.48.9', '3.48.10', '3.49.0-beta.1'].map(v => [v, {}])) };
  assert.equal(previousVersion(packument, '3.48.11'), '3.48.10');
  assert.equal(previousVersion(packument, '3.48.10'), '3.48.9');
  assert.equal(previousVersion(packument, '3.48.10', '3.48.8'), '3.48.8');
  assert.throws(() => previousVersion(packument, '3.48.10', '3.40.0'), /not published/);
  assert.throws(() => previousVersion({ versions: { '3.48.10': {} } }, '3.48.10'), /No published flujo-ai is older/);
});

test('the stand-in registry serves candidates, merges them into published documents and passes the rest through', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flujo-operator-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'operator-runbook-candidate.tgz');
  const bytes = tarball({ name: '@mario.andreschak/mcp-bash', version: '9.9.9' });
  await writeFile(file, bytes);
  const asked = [];
  const fetchImpl = async (url, options) => {
    asked.push([url, options.headers?.accept]);
    if (url.endsWith('/flujo-ai')) return new Response('{"name":"flujo-ai","versions":{}}', { status: 200 });
    if (url.endsWith('/@mario.andreschak%2fmcp-bash')) return new Response('{"name":"@mario.andreschak/mcp-bash","dist-tags":{"latest":"1.0.0"},"versions":{"1.0.0":{}}}');
    if (url.endsWith('/broken')) return new Response('upstream down', { status: 503 });
    if (url.endsWith('/@scope/pkg/-/pkg-1.0.0.tgz')) return new Response(Buffer.from('published bytes'), { headers: { 'content-type': 'application/octet-stream' } });
    throw new Error('network unreachable');
  };
  const registry = await startRegistry({ tarballs: [file], fetchImpl });
  t.after(() => registry.close());
  const get = (route, options) => fetch(new URL(route, registry.url), options);
  const merged = await (await get('@mario.andreschak%2fmcp-bash', { headers: { accept: 'application/vnd.npm.install-v1+json' } })).json();
  assert.deepEqual(Object.keys(merged.versions), ['1.0.0', '9.9.9']);
  assert.equal(merged.versions['9.9.9'].dist.tarball, `${registry.url}-/operator-runbook-candidate.tgz`);
  assert.deepEqual(Buffer.from(await (await get('-/operator-runbook-candidate.tgz')).arrayBuffer()), bytes);
  assert.equal((await get('-/other.tgz')).status, 404);
  const published = await get('@scope/pkg/-/pkg-1.0.0.tgz');
  assert.equal(published.status, 200);
  assert.equal(await published.text(), 'published bytes', 'npm downloads published package files through this registry too');
  assert.equal((await (await get('flujo-ai')).json()).name, 'flujo-ai');
  assert.equal((await get('broken')).status, 503);
  assert.equal((await get('unreachable')).status, 502);
  assert.equal((await get('flujo-ai', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await registry.published('flujo-ai')).name, 'flujo-ai');
  await assert.rejects(registry.published('broken'), /answered 503/);
  assert.equal(asked[0][1], 'application/vnd.npm.install-v1+json', 'npm\'s preferred format is asked for upstream');
});

test('options name one candidate and absolute paths', () => {
  assert.equal(parseOptions(['--pack']).pack, true);
  assert.equal(parseOptions(['--tarballs', path.resolve('/c'), '--from', '3.48.9']).from, '3.48.9');
  assert.deepEqual(parseOptions(['--help']), { help: true });
  for (const bad of [[], ['--pack', '--tarballs', path.resolve('/c')], ['--tarballs', 'relative'], ['--pack', '--from', 'latest'],
    ['--pack', '--report', 'r.json'], ['--pack', '--runbook', 'doc.md'], ['--pack', 'stray'], ['--pack', '--unknown']]) {
    assert.throws(() => parseOptions(bad), /Usage:/, JSON.stringify(bad));
  }
});

test('each shell stops a step at its first error', () => {
  assert.deepEqual(shellCommand('bash', 'echo hi'), { file: 'bash', args: ['-e', '-o', 'pipefail', '-c', 'echo hi'] });
  assert.deepEqual(shellCommand('powershell', 'Write-Output hi'), { file: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'\nWrite-Output hi"] });
});

test('the operator account is fresh: private home, npm cache and registry, and nothing else from the runner', () => {
  const env = operatorEnvironment({ sandbox: path.resolve('/box'), registryUrl: 'http://127.0.0.1:9/', sandboxPort: 5000, node: path.resolve('/rt/node'),
    variables: { FLUJO_PORT: '4300' }, inherited: { PATH: 'base', SystemRoot: 'C:\\Windows', GITHUB_TOKEN: 't', NPM_TOKEN: 'n', FLUJO_DATA_DIR: 'mine', HOME: '/real' } });
  assert.equal(env.PATH, [path.resolve('/rt'), 'base'].join(path.delimiter));
  assert.equal(env.SystemRoot, 'C:\\Windows');
  for (const name of ['GITHUB_TOKEN', 'NPM_TOKEN', 'FLUJO_DATA_DIR']) assert.equal(env[name], undefined, name);
  assert.equal(env.HOME, path.join(path.resolve('/box'), 'home'));
  assert.equal(env.npm_config_cache, path.join(path.resolve('/box'), 'npm-cache'));
  assert.equal(env.npm_config_registry, 'http://127.0.0.1:9/');
  assert.equal(env.FLUJO_PORT, '4300');
  assert.equal(env.FLUJO_MCP_APP_SANDBOX_PORT, '5000');
});

test('what each step promises is checked precisely', () => {
  assertDataFolder({ mcpServersDir: 'C:\\Box\\Data\\workspaces\\default-workspace\\mcp-servers' }, 'c:\\box\\data', 'win32');
  assert.throws(() => assertDataFolder({ mcpServersDir: '/home/op/.flujo/x' }, '/box/data', 'linux'), /outside the folder chosen/);
  assert.throws(() => assertDataFolder({}, '/box/data', 'linux'), /outside the folder chosen/);
  assertShowsVersion('{"success":true,"currentVersion":"3.48.10"}', '3.48.10');
  assertShowsVersion('3.48.10\r\n', '3.48.10');
  assert.throws(() => assertShowsVersion('3.48.100', '3.48.10'), /should show version 3.48.10/);
  assert.throws(() => assertShowsVersion('{"currentVersion":"3.48.1"}', '3.48.10'), /should show version/);
  assert.equal(assertNamesFailedJob('other: x\r\nNightly report: Provider refused (400)\n', 'Nightly report'), 'Nightly report: Provider refused (400)');
  assert.throws(() => assertNamesFailedJob('', 'Nightly report'), /should list "Nightly report"[\s\S]*\(nothing\)/);
  assert.throws(() => assertNamesFailedJob('Nightly report: ', 'Nightly report'), /should list/);
  assertSameView({ a: 1 }, { a: 1 }, 'After');
  assert.throws(() => assertSameView({ a: 1 }, { a: 2 }, 'After the upgrade'), /After the upgrade the data differs/);
});

test('the backup file must hold the flow, conversation and theme, and no setting value', async () => {
  const view = { theme: 'dark', flow: { name: 'Fixture' }, conversation: { messages: [{ role: 'user', content: 'hi' }] } };
  const archive = async ({ flows = [{ id: 'maintainer_drill_flow', name: 'Fixture' }], messages = view.conversation.messages, theme = 'dark',
    variables = { LABEL: { value: '', metadata: { isSecret: true } } }, omit } = {}) => {
    const zip = new JSZip();
    const files = { 'storage/flows.json': flows, 'storage/conversations/maintainer_drill_conversation.json': { messages }, 'storage/theme.json': theme,
      'storage/global_env_vars.json': variables };
    for (const [name, value] of Object.entries(files)) if (name !== omit) zip.file(name, JSON.stringify(value));
    return zip.generateAsync({ type: 'nodebuffer' });
  };
  await verifyBackupFile(await archive(), view, JSZip);
  await assert.rejects(verifyBackupFile(await archive({ flows: [] }), view, JSZip), /test flow/);
  await assert.rejects(verifyBackupFile(await archive({ messages: [] }), view, JSZip), /test conversation/);
  await assert.rejects(verifyBackupFile(await archive({ theme: 'light' }), view, JSZip), /theme/);
  await assert.rejects(verifyBackupFile(await archive({ variables: { LABEL: { value: 'secret' } } }), view, JSZip), /never leave in a backup/);
  await assert.rejects(verifyBackupFile(await archive({ omit: 'storage/theme.json' }), view, JSZip), /has no storage\/theme.json/);
});

function fakeOperator(fail) {
  const calls = [];
  const act = name => async () => { calls.push(name); if (name === fail) throw new Error(`${name} broke`); return { name }; };
  return {
    calls,
    operator: { chosen: act('choose'), start: id => act(id)(), run: id => { calls.push(`run ${id}`); if (`run ${id}` === fail) return Promise.reject(new Error(`${id} broke`)); return Promise.resolve(`${id} output`); },
      stop: act('stop'), dispose: act('dispose') },
    world: { prepare: act('prepare'), change: act('change') },
    checks: { installed: act('installed'), diagnosed: act('diagnosed'), backedUp: act('backedUp'), upgraded: act('upgraded'), restored: act('restored') },
  };
}

test('the journey follows the page in order and always stops what it started', async () => {
  const passing = fakeOperator();
  const report = await runJourney(passing);
  assert.equal(report.result, 'passed');
  assert.deepEqual(passing.calls, ['choose', 'start', 'run check', 'installed', 'prepare', 'run diagnose', 'diagnosed', 'run back-up', 'backedUp', 'stop',
    'upgrade', 'run check', 'upgraded', 'change', 'run restore', 'restored', 'stop', 'dispose']);
  assert.equal(report.steps.length, 12);

  const broken = fakeOperator('run diagnose');
  const failed = await runJourney(broken);
  assert.equal(failed.result, 'failed');
  assert.match(failed.failure, /diagnose broke/);
  assert.deepEqual(failed.steps.map(step => step.result).slice(-2), ['passed', 'failed']);
  assert.equal(broken.calls.at(-1), 'dispose', 'the app is stopped after a failed step');

  const stuck = fakeOperator('dispose');
  const notCleaned = await runJourney(stuck);
  assert.equal(notCleaned.result, 'failed');
  assert.match(notCleaned.cleanup, /dispose broke/);
});

test('a step command ends at once when the run gives up on it', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('FLUJO stopped while the step ran.')), 200);
  await assert.rejects(running, /FLUJO stopped while the step ran/);
  assert.ok(Date.now() - started < 10_000);
  const already = new AbortController(); already.abort('gave up');
  await assert.rejects(runCommand(process.execPath, ['-e', ''], { signal: already.signal }), /gave up/);
});
