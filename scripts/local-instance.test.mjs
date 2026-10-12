import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensurePrivateDirectory, prepareLocalInstance, privateStorageFailureStage, readPrivateJson, writePrivateJson } from './local-instance.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flujo-native-private-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^flujo-native-private-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function powershell(script, filename) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return execFileSync(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 1024,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, FLUJO_TEST_PATH: filename } });
}

test('native private instance registers, reads and cleans its disposable descriptor on this platform', async (t) => {
  const root = await fixture(t);
  if (process.platform === 'win32') {
    const sameOwner = powershell('$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); [Console]::Out.Write($identity.User.Value -eq $identity.Owner.Value)', root);
    t.diagnostic(`Windows effective token owner is its user: ${sameOwner}`);
  }
  let instance;
  try {
    instance = await prepareLocalInstance({
      env: { FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_LOCAL_INSTANCE_DIR: path.join(root, 'instances') },
      args: ['start', '-p', '4210', '-H', '127.0.0.1'], appRoot: root,
    });
    await instance.register(process.pid);
    const filename = path.join(root, 'instances', `${instance.env.FLUJO_LOCAL_INSTANCE_ID}.json`);
    const record = await readPrivateJson(filename);
    assert.equal(record.pid, process.pid);
    assert.equal(record.origin, 'http://127.0.0.1:4210');
    assert.equal(record.token, instance.env.FLUJO_SNAPSHOT_CONTROL_TOKEN);
    instance.cleanup();
    assert.deepEqual(await readdir(path.join(root, 'instances')), []);
  } catch (error) {
    t.diagnostic(`Private storage failure stage: ${privateStorageFailureStage(error) || 'unspecified'}`);
    throw error;
  } finally { instance?.cleanup(); }
});

test('a private record with a newly introduced outside reader is refused without leaking details', async (t) => {
  const root = await fixture(t);
  const filename = path.join(root, 'instances', 'synthetic.json');
  await writePrivateJson(filename, { token: 'synthetic-private-value' });
  if (process.platform === 'win32') {
    powershell(String.raw`
$ErrorActionPreference = 'Stop'
$p = [Environment]::GetEnvironmentVariable('FLUJO_TEST_PATH')
$acl = [IO.File]::GetAccessControl($p)
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.File]::SetAccessControl($p, $acl)
`, filename);
  } else await chmod(filename, 0o644);
  await assert.rejects(readPrivateJson(filename), (error) => {
    assert.match(error.message, /unsafe/);
    assert.ok(!error.message.includes(filename));
    assert.ok(!error.message.includes('synthetic-private-value'));
    if (process.platform === 'win32') assert.equal(privateStorageFailureStage(error), 'windows-verify');
    return true;
  });
});

test('linked discovery storage is refused before descriptor publication', async (t) => {
  const root = await fixture(t);
  const target = await ensurePrivateDirectory(path.join(root, 'target'));
  const linked = path.join(root, 'linked');
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareLocalInstance({ env: { FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_LOCAL_INSTANCE_DIR: linked }, appRoot: root }), /unsafe/);
  assert.deepEqual(await readdir(target), []);
});

test('storage diagnostics permit only fixed stage labels', () => {
  for (const error of [undefined, null, new Error('sensitive detail'), { storageStage: 'C:/private/path' }, { storageStage: 'windows-verify\nsecret' }]) {
    assert.equal(privateStorageFailureStage(error), undefined);
  }
  assert.equal(privateStorageFailureStage({ storageStage: 'windows-helper-timeout' }), 'windows-helper-timeout');
});
