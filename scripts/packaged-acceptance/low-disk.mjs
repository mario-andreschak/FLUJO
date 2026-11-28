// The data folder of every run lives on its own small volume, so "disk full"
// in the disk-full check is the operating system's own answer (ENOSPC), not a
// simulated error. Linux uses tmpfs, Windows a virtual disk, macOS a disk
// image and Docker a tmpfs volume that a holder container keeps mounted.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { delay, runCommand } from './targets.mjs';

export const LOW_DISK_MIB = 256;
const MIB = 1024 * 1024;
/** Filling may go a little past the nominal size (file system metadata); anything more means the wrong volume. */
export const fillLimitBytes = sizeMiB => (sizeMiB + 64) * MIB;
const FILLER = 'filler.bin';

/**
 * Fill the volume of a folder to its last byte. Runs as its own Node process
 * (`node -e FILL_SCRIPT <folder> <limit>`) on the host or inside a container,
 * so both use the same steps. Prints the bytes written as JSON.
 */
export const FILL_SCRIPT = String.raw`
const fs = require('fs'); const path = require('path');
const [directory, limitText] = process.argv.slice(1);
const limit = Number(limitText);
if (!directory || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Usage: <folder> <limit-bytes>');
const fd = fs.openSync(path.join(directory, '${FILLER}'), 'wx');
let written = 0;
try {
  for (const size of [4194304, 65536, 4096, 512, 1]) {
    const chunk = Buffer.alloc(size);
    for (;;) {
      let bytes;
      try { bytes = fs.writeSync(fd, chunk, 0, size); } catch (error) { if (error.code === 'ENOSPC') break; throw error; }
      written += bytes;
      if (written > limit) throw new Error('The test volume holds more than ' + limit + ' bytes; it is not the small volume.');
      if (bytes < size) break;
    }
  }
  try { fs.fsyncSync(fd); } catch (error) { if (error.code !== 'ENOSPC') throw error; }
} finally { fs.closeSync(fd); }
process.stdout.write(JSON.stringify({ fillerBytes: written }));
`;

export function parseFillResult(output) {
  let result;
  try { result = JSON.parse(output); } catch { result = undefined; }
  if (!Number.isSafeInteger(result?.fillerBytes) || result.fillerBytes <= 0) {
    throw new Error(`Filling the test volume gave no usable result: ${String(output).slice(0, 200)}`);
  }
  return result;
}

const quote = value => `"${value}"`;

/** Commands that create and remove the small volume on each operating system. */
export function hostVolumePlan({ platform, mountPoint, workDirectory, sizeMiB = LOW_DISK_MIB, uid, gid, root = uid === 0 }) {
  if (platform === 'linux') {
    const privileged = args => root ? args : ['sudo', '-n', ...args];
    return {
      description: `${sizeMiB} MiB tmpfs`,
      scripts: {},
      create: [privileged(['mount', '-t', 'tmpfs', '-o', `size=${sizeMiB}m,mode=0700,uid=${uid},gid=${gid}`, 'flujo-acceptance', mountPoint])],
      remove: [privileged(['umount', mountPoint])],
      needs: 'root or passwordless sudo (as on CI runners) to mount a small tmpfs',
    };
  }
  if (platform === 'darwin') {
    const image = path.posix.join(workDirectory, 'low-disk.dmg');
    return {
      description: `${sizeMiB} MiB disk image`,
      scripts: {},
      create: [['hdiutil', 'create', '-size', `${sizeMiB}m`, '-fs', 'HFS+', '-volname', 'FLUJO acceptance', '-layout', 'NONE', image],
        ['hdiutil', 'attach', image, '-nobrowse', '-mountpoint', mountPoint]],
      remove: [['hdiutil', 'detach', mountPoint, '-force']],
      files: [image],
      needs: 'hdiutil, which every macOS has',
    };
  }
  if (platform === 'win32') {
    const disk = path.win32.join(workDirectory, 'low-disk.vhdx');
    const createScript = path.win32.join(workDirectory, 'low-disk-create.txt');
    const removeScript = path.win32.join(workDirectory, 'low-disk-remove.txt');
    return {
      description: `${sizeMiB} MiB virtual disk`,
      scripts: {
        [createScript]: [`create vdisk file=${quote(disk)} maximum=${sizeMiB} type=expandable`, `select vdisk file=${quote(disk)}`,
          'attach vdisk', 'create partition primary', 'format fs=ntfs quick label=FLUJOTEST', `assign mount=${quote(mountPoint)}`].join('\r\n'),
        [removeScript]: [`select vdisk file=${quote(disk)}`, 'detach vdisk'].join('\r\n'),
      },
      create: [['diskpart', '/s', createScript]],
      remove: [['diskpart', '/s', removeScript]],
      files: [disk],
      needs: 'an administrator (elevated) shell, as on CI runners, to attach a virtual disk with diskpart',
    };
  }
  throw new Error(`The disk-full check cannot create a small volume on ${platform}.`);
}

async function runAll(commands, run) {
  for (const [file, ...args] of commands) await run(file, args, { timeoutMs: 120_000 });
}

/** Fill, then free, a volume whose filler lives at `fillerDirectory`. */
function hostFiller({ fillerDirectory, sizeMiB, run, node }) {
  return {
    async fill() {
      try {
        return parseFillResult(await run(node, ['-e', FILL_SCRIPT, fillerDirectory, String(fillLimitBytes(sizeMiB))], { timeoutMs: 120_000 }));
      } catch (error) {
        await rm(path.join(fillerDirectory, FILLER), { force: true });
        throw error;
      }
    },
    free: () => rm(path.join(fillerDirectory, FILLER), { force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

/** Removing a volume can race the last file handles of a process that just ended. */
async function retry(operation, { attempts = 10, pause = delay, waitMs = 500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); } catch (error) {
      if (attempt >= attempts) throw error;
      await pause(waitMs);
    }
  }
}

/**
 * Create the small volume for a host run. `root` is the folder on it; the data
 * folder goes into `root/data` and the filler next to it, so the app never
 * sees the filler.
 */
export async function createHostVolume({ workDirectory, sizeMiB = LOW_DISK_MIB, platform = process.platform, run = runCommand,
  node = process.execPath, uid = process.getuid?.(), gid = process.getgid?.(), pause = delay }) {
  const mountPoint = path.join(workDirectory, 'volume');
  await mkdir(mountPoint, { recursive: true });
  const plan = hostVolumePlan({ platform, mountPoint, workDirectory, sizeMiB, uid, gid });
  for (const [file, text] of Object.entries(plan.scripts)) await writeFile(file, text);
  try {
    await runAll(plan.create, run);
  } catch (error) {
    throw new Error(`Could not create the ${plan.description} for the disk-full check; it needs ${plan.needs}.\n${error.message}`);
  }
  const removeVolume = async () => {
    await retry(() => runAll(plan.remove, run), { pause });
    for (const file of [...(plan.files ?? []), ...Object.keys(plan.scripts)]) await rm(file, { force: true });
  };
  const filler = hostFiller({ fillerDirectory: mountPoint, sizeMiB, run, node });
  let capacityBytes;
  try {
    // Filling once before the app starts proves the volume is real and small.
    ({ fillerBytes: capacityBytes } = await filler.fill());
    await filler.free();
  } catch (error) {
    await removeVolume().catch(() => {});
    throw error;
  }
  return { root: mountPoint, description: plan.description, capacityBytes, ...filler, remove: removeVolume };
}

/**
 * A tmpfs Docker volume. The local volume driver unmounts (and so empties) a
 * tmpfs volume when no container uses it, so a small holder container keeps
 * it mounted across app restarts and upgrades. The app mounts the `data`
 * subfolder; the filler lives next to it.
 */
export function createDockerVolume({ name, image, sizeMiB = LOW_DISK_MIB, docker, label }) {
  const holder = `${name}-holder`;
  let created = false; let holding = false;
  const exec = (script, args = [], options) => docker(['exec', holder, 'node', '-e', script, ...args], options);
  return {
    name,
    description: `${sizeMiB} MiB tmpfs Docker volume`,
    mount: `type=volume,src=${name},dst=/app/data,volume-subpath=data`,
    async prepare() {
      await docker(['volume', 'create', '--driver', 'local', '--label', label, '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
        '--opt', `o=size=${sizeMiB}m,uid=1000,gid=1000,mode=0755`, name]);
      created = true;
      await docker(['run', '--detach', '--name', holder, '--label', label, '--network', 'none', '--user', '1000:1000',
        '--volume', `${name}:/volume`, '--entrypoint', 'node', image, '-e', 'setInterval(() => {}, 1 << 30)']);
      holding = true;
      // Filling once before the app starts proves the volume is real and small.
      await this.fill();
      await this.free();
      await exec("require('fs').mkdirSync('/volume/data', { recursive: true })");
    },
    async fill() {
      try {
        return parseFillResult(await exec(FILL_SCRIPT, ['/volume', String(fillLimitBytes(sizeMiB))], { timeoutMs: 120_000 }));
      } catch (error) {
        await this.free().catch(() => {});
        throw error;
      }
    },
    free: () => exec(`require('fs').rmSync('/volume/${FILLER}', { force: true })`),
    async remove() {
      if (holding) await docker(['rm', '--force', holder]);
      holding = false;
      if (created) await docker(['volume', 'rm', '--force', name]);
      created = false;
    },
  };
}
