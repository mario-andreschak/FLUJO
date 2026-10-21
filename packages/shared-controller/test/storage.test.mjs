import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrivateDirectory, createPrivateDirectory, createPrivateFile, readPrivateFile } from '../dist/private-storage.js';
import { configSchema } from '../dist/config.js';
import { setupController } from '../dist/setup.js';
import { privateFixture } from './private-fixture.mjs';

test('private storage refuses linked files, redirected directories and oversized reads', t => {
  const { directory } = privateFixture(t);
  const filename = join(directory, 'secret.json');
  const fd = createPrivateFile(filename);
  try { writeFileSync(fd, 'private fixture'); } finally { closeSync(fd); }
  assert.equal(readPrivateFile(filename).toString(), 'private fixture');
  assert.throws(() => readPrivateFile(filename, 4));
  assert.throws(() => createPrivateFile(filename));
  assert.throws(() => createPrivateDirectory(directory));
  const linked = join(directory, 'hard-link.json');
  linkSync(filename, linked);
  assert.throws(() => readPrivateFile(filename));
  assert.throws(() => readPrivateFile(linked));
  const target = createPrivateDirectory(join(directory, 'target'));
  const redirected = join(directory, 'redirected');
  symlinkSync(target, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertPrivateDirectory(redirected));
});

test('POSIX storage refuses readable secrets and replaceable ancestors', { skip: process.platform === 'win32' }, t => {
  const { directory } = privateFixture(t);
  const filename = join(directory, 'exposed.json');
  writeFileSync(filename, 'fixture', { mode: 0o644 });
  chmodSync(filename, 0o644);
  assert.throws(() => readPrivateFile(filename));
  const child = createPrivateDirectory(join(directory, 'child'));
  chmodSync(directory, 0o702);
  assert.throws(() => assertPrivateDirectory(child));
});

function grantEveryone(filename, rights, inheritOnly = false) {
  // Fixed test-only native ACL mutation. JSON stdin carries the owned fixture
  // path; no shell interpolation or host/user ACL is changed.
  const program = String.raw`
$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
$inputReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false,$true))
$request = $json.DeserializeObject($inputReader.ReadToEnd())
$target = [IO.DirectoryInfo]::new([string]$request.filename)
$acl = $target.GetAccessControl()
$inherit = if ($request.inheritOnly) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
$propagate = if ($request.inheritOnly) { [Security.AccessControl.PropagationFlags]::InheritOnly } else { [Security.AccessControl.PropagationFlags]::None }
$rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]([string]$request.rights),$inherit,$propagate,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
$target.SetAccessControl($acl)
`;
  const result = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')],
    { input: JSON.stringify({ filename, rights, inheritOnly }), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, 'Native fixture ACL mutation must succeed');
}

test('Windows storage rejects exposed future children and replaceable private ancestors', { skip: process.platform !== 'win32' }, t => {
  const { directory } = privateFixture(t);
  const exposed = createPrivateDirectory(join(directory, 'exposed'));
  grantEveryone(exposed, 'Read', true);
  assert.throws(() => assertPrivateDirectory(exposed));
  const newFile = join(exposed, 'must-not-write-secret');
  assert.throws(() => createPrivateFile(newFile));
  assert.equal(existsSync(newFile), false);
  const ancestor = createPrivateDirectory(join(directory, 'ancestor'));
  const child = createPrivateDirectory(join(ancestor, 'private-child'));
  grantEveryone(ancestor, 'DeleteSubdirectoriesAndFiles');
  assert.throws(() => assertPrivateDirectory(child));
});

test('setup writes independent private credentials without executing the CLI or overwriting an installation', t => {
  const { directory } = privateFixture(t);
  const bin = createPrivateDirectory(join(directory, 'bin'));
  // Deliberately not an executable program: setup may locate it, never run it.
  const executable = join(bin, process.platform === 'win32' ? 'docker.exe' : 'docker');
  writeFileSync(executable, 'not executable content', { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  const imageId = `sha256:${'a'.repeat(64)}`;
  const aliceRoot = join(directory, 'alice - café');
  const alice = setupController(aliceRoot, 'alice', imageId);
  const first = configSchema.parse(JSON.parse(readPrivateFile(alice.configFile).toString()));
  assert.equal(first.localEngine.imageId, imageId);
  assert.equal(first.runtimes[0].origin, 'https://alice.localhost');
  assert.equal(first.runtimes[0].localRuntime, undefined);
  assert.equal(JSON.stringify(alice).includes(first.runtimes[0].credential), false);
  assert.throws(() => setupController(aliceRoot, 'bob', imageId));
  assert.deepEqual(JSON.parse(readPrivateFile(alice.configFile).toString()), first);
  const bob = setupController(join(directory, 'bob'), 'bob', imageId);
  const second = JSON.parse(readPrivateFile(bob.configFile).toString());
  assert.notEqual(first.runtimes[0].credential, second.runtimes[0].credential);
  const invalid = join(directory, 'invalid');
  assert.throws(() => setupController(invalid, 'alice.localhost', imageId));
  assert.throws(() => setupController(invalid, 'alice', 'latest'));
  process.env.PATH = '.';
  assert.throws(() => setupController(invalid, 'alice', imageId));
  assert.equal(existsSync(invalid), false);
});
