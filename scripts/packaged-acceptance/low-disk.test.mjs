// Tests for the small data volume of the packaged acceptance checks. Creating a
// real volume needs root or an administrator shell; CI runners have that, so
// the "real volume" test runs there and is skipped where it cannot be created.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FILL_SCRIPT, LOW_DISK_MIB, createDockerVolume, createHostVolume, fillLimitBytes, hostVolumePlan, parseFillResult } from './low-disk.mjs';
import { runCommand } from './targets.mjs';

async function folder(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'flujo-low-disk-test-')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return directory;
}

test('each operating system gets its own small volume, with the privilege it needs named', () => {
  const linux = hostVolumePlan({ platform: 'linux', mountPoint: '/w/volume', workDirectory: '/w', uid: 1001, gid: 121 });
  assert.deepEqual(linux.create, [['sudo', '-n', 'mount', '-t', 'tmpfs', '-o', `size=${LOW_DISK_MIB}m,mode=0700,uid=1001,gid=121`, 'flujo-acceptance', '/w/volume']]);
  assert.deepEqual(linux.remove, [['sudo', '-n', 'umount', '/w/volume']]);
  assert.match(linux.needs, /passwordless sudo/);
  assert.deepEqual(hostVolumePlan({ platform: 'linux', mountPoint: '/v', workDirectory: '/w', uid: 0, gid: 0 }).create[0].slice(0, 2), ['mount', '-t'], 'root mounts directly');

  const mac = hostVolumePlan({ platform: 'darwin', mountPoint: '/w/volume', workDirectory: '/w', sizeMiB: 64 });
  assert.deepEqual(mac.create, [['hdiutil', 'create', '-size', '64m', '-fs', 'HFS+', '-volname', 'FLUJO acceptance', '-layout', 'NONE', '/w/low-disk.dmg'],
    ['hdiutil', 'attach', '/w/low-disk.dmg', '-nobrowse', '-mountpoint', '/w/volume']]);
  assert.deepEqual(mac.remove, [['hdiutil', 'detach', '/w/volume', '-force']]);
  assert.deepEqual(mac.files, ['/w/low-disk.dmg']);

  const windows = hostVolumePlan({ platform: 'win32', mountPoint: 'C:\\Temp\\box dir\\volume', workDirectory: 'C:\\Temp\\box dir', sizeMiB: 64 });
  assert.deepEqual(windows.create, [['diskpart', '/s', 'C:\\Temp\\box dir\\low-disk-create.txt']]);
  assert.deepEqual(windows.remove, [['diskpart', '/s', 'C:\\Temp\\box dir\\low-disk-remove.txt']]);
  assert.equal(windows.scripts['C:\\Temp\\box dir\\low-disk-create.txt'], [
    'create vdisk file="C:\\Temp\\box dir\\low-disk.vhdx" maximum=64 type=expandable', 'select vdisk file="C:\\Temp\\box dir\\low-disk.vhdx"',
    'attach vdisk', 'create partition primary', 'format fs=ntfs quick label=FLUJOTEST', 'assign mount="C:\\Temp\\box dir\\volume"'].join('\r\n'));
  assert.equal(windows.scripts['C:\\Temp\\box dir\\low-disk-remove.txt'], 'select vdisk file="C:\\Temp\\box dir\\low-disk.vhdx"\r\ndetach vdisk');
  assert.match(windows.needs, /administrator/);
  assert.throws(() => hostVolumePlan({ platform: 'aix', mountPoint: '/v', workDirectory: '/w' }), /cannot create a small volume on aix/);
});

test('the fill result must report the bytes written', () => {
  assert.deepEqual(parseFillResult('{"fillerBytes":4096}'), { fillerBytes: 4096 });
  for (const bad of ['', 'not json', '{"fillerBytes":0}', '{"fillerBytes":"1"}', '{}']) assert.throws(() => parseFillResult(bad), /no usable result/, bad);
});

test('a host volume is created, proven small by one fill, then filled, freed and removed with the planned commands', async t => {
  const directory = await folder(t);
  const calls = [];
  const run = async file => {
    calls.push(path.basename(file));
    if (file === process.execPath) return JSON.stringify({ fillerBytes: 1_000_000 });
    return '';
  };
  const volume = await createHostVolume({ workDirectory: directory, platform: 'linux', uid: 1, gid: 2, run, sizeMiB: 1 });
  assert.equal(volume.root, path.join(directory, 'volume'));
  assert.equal(volume.description, '1 MiB tmpfs');
  assert.equal(volume.capacityBytes, 1_000_000);
  assert.ok((await stat(volume.root)).isDirectory());
  assert.deepEqual(await volume.fill(), { fillerBytes: 1_000_000 });
  await volume.free();
  await volume.remove();
  assert.deepEqual(calls, ['sudo', path.basename(process.execPath), path.basename(process.execPath), 'sudo']);
});

test('a "volume" that is really a big disk is never filled past the limit, leaves no filler and is removed again', async t => {
  const directory = await folder(t);
  const removed = [];
  const run = async (file, args, options) => {
    if (file === process.execPath) return runCommand(file, args, options);
    if (args.includes('umount')) removed.push(args);
    return '';
  };
  await assert.rejects(createHostVolume({ workDirectory: directory, platform: 'linux', uid: 1, gid: 1, run, sizeMiB: 1 }), /holds more than/);
  assert.deepEqual(await readdir(path.join(directory, 'volume')), []);
  assert.equal(removed.length, 1);
});

test('a volume that cannot be created says what it needs', async t => {
  const directory = await folder(t);
  // Plans write their scripts next to the volume, so each platform is tried with a folder of its own kind.
  const expected = process.platform === 'win32'
    ? ['win32', /Could not create the 256 MiB virtual disk for the disk-full check; it needs an administrator \(elevated\) shell[\s\S]*refused/]
    : ['linux', /Could not create the 256 MiB tmpfs for the disk-full check; it needs root or passwordless sudo[\s\S]*refused/];
  await assert.rejects(createHostVolume({ workDirectory: directory, platform: expected[0], uid: 1001, gid: 1001,
    run: async () => { throw new Error('refused'); } }), expected[1]);
  assert.deepEqual((await readdir(directory)).filter(name => !['volume', 'low-disk-create.txt', 'low-disk-remove.txt'].includes(name)), []);
});

test('removing a volume retries while the last file handles close, then deletes its files', async t => {
  const directory = await folder(t);
  let attempts = 0;
  const fake = detach => async (file, args) => {
    if (file === process.execPath) return '{"fillerBytes":4096}';
    if (args.includes('detach')) return detach();
    return '';
  };
  const volume = await createHostVolume({ workDirectory: directory, platform: 'darwin', run: fake(() => { if (++attempts < 3) throw new Error('busy'); return ''; }), pause: async () => {} });
  await volume.remove();
  assert.equal(attempts, 3);
  await assert.rejects(stat(path.join(directory, 'low-disk.dmg')), { code: 'ENOENT' });
  const stuck = await createHostVolume({ workDirectory: directory, platform: 'darwin', run: fake(() => { throw new Error('still busy'); }), pause: async () => {} });
  await assert.rejects(stuck.remove(), /still busy/);
});

test('a container volume is a tmpfs volume kept mounted by a holder, with the app on its data folder', async () => {
  const calls = [];
  let fill = '{"fillerBytes":268435456}';
  const docker = async args => {
    calls.push(args[0] === 'exec' ? `exec ${args.slice(1, 4).join(' ')} ${args.slice(5).join(' ')}`.trim() : args.join(' '));
    if (args.includes(FILL_SCRIPT)) { if (fill instanceof Error) throw fill; return fill; }
    return '';
  };
  const volume = createDockerVolume({ name: 'vol', image: 'sha256:feed', docker, label: 'io.flujo.packaged-acceptance=volume' });
  assert.equal(volume.mount, 'type=volume,src=vol,dst=/app/data,volume-subpath=data');
  await volume.prepare();
  assert.deepEqual(await volume.fill(), { fillerBytes: 268435456 });
  await volume.free();
  fill = new Error('ENOSPC was never reached');
  await assert.rejects(volume.fill(), /never reached/);
  await volume.remove();
  await volume.remove();
  assert.deepEqual(calls, [
    `volume create --driver local --label io.flujo.packaged-acceptance=volume --opt type=tmpfs --opt device=tmpfs --opt o=size=${LOW_DISK_MIB}m,uid=1000,gid=1000,mode=0755 vol`,
    'run --detach --name vol-holder --label io.flujo.packaged-acceptance=volume --network none --user 1000:1000 --volume vol:/volume --entrypoint node sha256:feed -e setInterval(() => {}, 1 << 30)',
    `exec vol-holder node -e /volume ${fillLimitBytes(LOW_DISK_MIB)}`,
    'exec vol-holder node -e',
    'exec vol-holder node -e',
    `exec vol-holder node -e /volume ${fillLimitBytes(LOW_DISK_MIB)}`,
    'exec vol-holder node -e',
    `exec vol-holder node -e /volume ${fillLimitBytes(LOW_DISK_MIB)}`,
    'exec vol-holder node -e',
    'rm --force vol-holder',
    'volume rm --force vol',
  ]);
});

function canMountTmpfs() {
  if (process.platform !== 'linux') return false;
  try { execFileSync(process.getuid() === 0 ? 'true' : 'sudo', process.getuid() === 0 ? [] : ['-n', 'true'], { stdio: 'ignore' }); return true; } catch { return false; }
}
function isElevatedWindows() {
  if (process.platform !== 'win32') return false;
  try { execFileSync('net', ['session'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('a real small volume reports a full disk to the operating system and works again once freed',
  { skip: !(canMountTmpfs() || isElevatedWindows()) && 'needs root, passwordless sudo or an elevated Windows shell (CI runners have them)' }, async t => {
    const directory = await folder(t);
    const volume = await createHostVolume({ workDirectory: directory, sizeMiB: 16 });
    try {
      const { fillerBytes } = await volume.fill();
      assert.ok(fillerBytes > 8 * 1024 * 1024 && fillerBytes <= fillLimitBytes(16), String(fillerBytes));
      const probe = path.join(volume.root, 'probe.json');
      const write = () => runCommand(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(probe)}, 'x'.repeat(65536))`]);
      await assert.rejects(write(), /ENOSPC|not enough space/i);
      await volume.free();
      await write();
      assert.equal((await readFile(probe, 'utf8')).length, 65536);
    } finally {
      await volume.remove();
    }
  });
