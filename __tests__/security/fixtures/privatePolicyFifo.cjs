const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

/** Use a separate writer watchdog: a blocking sync open also blocks this process's timers. */
module.exports = async function probePrivatePolicyFifo(read, forceBlocking = false) {
  const directory = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'flujo-policy-fifo-'));
  const filename = path.join(directory, 'policy.json');
  const marker = path.join(directory, 'watchdog-released');
  const nativeOpen = fs.openSync;
  const nativeRead = fs.readSync;
  const nativeClose = fs.closeSync;
  let writer;
  let writerExited;
  let descriptor;
  let flagsUsed;
  let reads = 0;
  let closes = 0;
  let swapped = false;
  let denied = false;
  fs.writeFileSync(filename, '{"fixture":true}', { mode: 0o600 });
  const started = performance.now();
  try {
    fs.openSync = (file, flags, mode) => {
      if (file !== filename) return nativeOpen(file, flags, mode);
      fs.unlinkSync(filename);
      execFileSync('mkfifo', [filename], { timeout: 1000, windowsHide: true });
      swapped = true;
      writer = spawn(process.execPath, ['-e', `const fs=require('node:fs');setTimeout(()=>{
        fs.writeFileSync(process.argv[2],'released');
        try {const fd=fs.openSync(process.argv[1],fs.constants.O_WRONLY|fs.constants.O_NONBLOCK);fs.closeSync(fd);}
        catch(error){if(error.code!=='ENXIO')process.exitCode=1;}
      },750);`, filename, marker], {
        env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdio: 'ignore', windowsHide: true,
      });
      writerExited = new Promise((resolve, reject) => {
        writer.once('exit', resolve); writer.once('error', reject);
      });
      flagsUsed = forceBlocking ? (typeof flags === 'number' ? flags & ~fs.constants.O_NONBLOCK : flags) : flags;
      descriptor = nativeOpen(file, flagsUsed, mode);
      return descriptor;
    };
    fs.readSync = (...args) => { if (args[0] === descriptor) reads += 1; return nativeRead(...args); };
    fs.closeSync = fd => { if (fd === descriptor) closes += 1; return nativeClose(fd); };
    try { read(filename); } catch { denied = true; }
    return { denied, swapped, reads, closes, watchdogReleased: fs.existsSync(marker),
      nonblocking: typeof flagsUsed === 'number' && Boolean(flagsUsed & fs.constants.O_NONBLOCK),
      elapsedMs: performance.now() - started };
  } finally {
    fs.openSync = nativeOpen; fs.readSync = nativeRead; fs.closeSync = nativeClose;
    if (writer) {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
      await writerExited;
    }
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !/^flujo-policy-fifo-[A-Za-z0-9]+$/.test(path.basename(resolved))
        || fs.realpathSync.native(resolved) !== resolved) throw new Error('Unsafe policy FIFO fixture cleanup');
    fs.rmSync(resolved, { recursive: true });
  }
};
