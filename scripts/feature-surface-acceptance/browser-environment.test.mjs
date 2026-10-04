import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectCandidateRoot, fixtureRuntimeEnvironment, createFeatureBrowserEnvironment,
  observeOwnedCandidate, stopOwnedCandidate } from './browser-environment.mjs';

async function metadataRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-candidate-metadata-'));
  t.after(async () => {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)
      || !path.basename(root).startsWith('feature-candidate-metadata-')) throw new Error('Unsafe test cleanup path.');
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, '.next'));
  await fs.writeFile(path.join(root, '.next', 'BUILD_ID'), 'SYNTHETIC-NOT-A-BUILD');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'flujo-ai', version: '0.0.0-synthetic' }));
  return root;
}

test('metadata inspection never awards source correspondence or installed acceptance', async t => {
  const record = await inspectCandidateRoot(await metadataRoot(t));
  assert.equal(record.buildId, 'SYNTHETIC-NOT-A-BUILD');
  assert.equal(record.sourceCorrespondence, 'not_verified');
  assert.equal(record.installedAcceptance, 'not_evaluated');
  assert.match(record.packageManifestSha256, /^[a-f0-9]{64}$/);
});

for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  test(`refuses candidate dotenv ${name} before starting a process`, async t => {
    const root = await metadataRoot(t);
    await fs.writeFile(path.join(root, name), 'SYNTHETIC_ONLY=unused');
    await assert.rejects(inspectCandidateRoot(root), /dotenv/);
  });
}

test('runtime environment carries system paths but no inherited provider, owner, worker or Node injection settings', () => {
  const env = fixtureRuntimeEnvironment({ dataDir: 'synthetic-data', baseURL: 'http://127.0.0.1:4317', fixtureUrl: 'http://127.0.0.1:9317', sandboxPort: 4318,
    hostEnvironment: { Path: 'synthetic-path', SystemRoot: 'synthetic-system', OPENAI_API_KEY: 'synthetic-key',
      FLUJO_OWNER_AUTH_FILE: 'synthetic-policy', FLUJO_DATA_DIR: 'synthetic-private-root', FLUJO_SNAPSHOT_CONTROL_TOKEN: 'synthetic-worker',
      NODE_OPTIONS: '--require=synthetic', CODEX_TOKEN: 'synthetic-token', HOME: 'synthetic-home',
      FLUJO_MCP_APP_SANDBOX_PORT: '4201', FLUJO_MCP_APP_SANDBOX_HOST: '0.0.0.0', FLUJO_MCP_APP_SANDBOX_ALLOW_ALL: '1' } });
  assert.equal(env.Path, 'synthetic-path');
  assert.equal(env.SystemRoot, 'synthetic-system');
  assert.equal(env.FLUJO_DATA_DIR, 'synthetic-data');
  assert.equal(env.FLUJO_MCP_APP_SANDBOX_PORT, '4318');
  assert.equal(env.FLUJO_MCP_APP_SANDBOX_HOST, '127.0.0.1');
  assert.ok(!('FLUJO_MCP_APP_SANDBOX_ALLOW_ALL' in env));
  for (const key of ['OPENAI_API_KEY', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_SNAPSHOT_CONTROL_TOKEN', 'NODE_OPTIONS', 'CODEX_TOKEN', 'HOME']) {
    assert.ok(!(key in env));
  }
});

test('missing candidate and invalid ports fail before process/profile creation', async () => {
  await assert.rejects(createFeatureBrowserEnvironment(), /FEATURE_BROWSER_APP_DIR/);
  for (const port of [-1, 1, 65536, 1.5, '4317']) {
    await assert.rejects(createFeatureBrowserEnvironment({ applicationRoot: 'unused', port }), /Invalid feature browser port/);
  }
});

async function syntheticChild(t, action) {
  const script = `setInterval(() => {}, 1000); process.on('message', message => {
    if (message === 'stop') { ${action} }
  }); process.send('synthetic-ready');`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const record = observeOwnedCandidate(child);
  t.after(async () => {
    if (!record.epoch.completedAt) {
      child.kill();
      await record.completed;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic child did not become ready.')), 5000);
    child.once('message', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return record;
}

for (const code of [0, 143]) {
  test(`owned synthetic child drains its output and closes after graceful exit ${code}`, async t => {
    const record = await syntheticChild(t, `process.stdout.write('final synthetic log'); process.exit(${code});`);
    let output = '';
    record.child.stdout.on('data', chunk => { output += chunk; });
    await stopOwnedCandidate(record, { graceMs: 5000 });
    assert.equal(record.epoch.exitCode, code);
    assert.ok(record.epoch.completedAt);
    assert.ok(record.epoch.ioDrainedAt);
    assert.equal(record.epoch.forcedStop, false);
    assert.equal(output, 'final synthetic log');
  });
}

test('an unresponsive owned synthetic child is killed and its observed close remains a failure', async t => {
  const record = await syntheticChild(t, '/* intentionally ignores stop */');
  await assert.rejects(stopOwnedCandidate(record, { graceMs: 50 }), /forced shutdown; exit and pipe closure observed/);
  assert.equal(record.epoch.forcedStop, true);
  assert.ok(record.epoch.completedAt);
});

test('a disconnected owned IPC channel cannot leave its synthetic child running', async t => {
  const record = await syntheticChild(t, '/* unreachable after disconnect */');
  record.child.disconnect();
  await assert.rejects(stopOwnedCandidate(record), /forced shutdown; exit and pipe closure observed/);
  assert.ok(record.epoch.completedAt);
  assert.equal(record.epoch.forcedStop, true);
});

test('an abnormal owned synthetic child exit remains a shutdown failure', async t => {
  const record = await syntheticChild(t, 'process.exit(7);');
  await assert.rejects(stopOwnedCandidate(record, { graceMs: 5000 }), /stop failed \(7\)/);
  assert.equal(record.epoch.exitCode, 7);
  assert.ok(record.epoch.completedAt);
});
