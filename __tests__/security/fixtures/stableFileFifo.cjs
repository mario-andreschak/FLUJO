const native = require('node:fs');
const fs = native.promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Controlled source probe: replace only this fixture's regular file with a FIFO. */
module.exports = async function probeFifo(readStableFile, forceBlocking = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-stable-fifo-'));
  const file = path.join(directory, 'metadata');
  const originalOpen = fs.open;
  let timer;
  let swapped = false;
  let watchdogReleased = false;
  let closedDescriptors = 0;
  let denied = false;
  let actualFlags;
  const started = performance.now();
  try {
    await fs.writeFile(file, 'fixture');
    fs.open = async (requested, flags, mode) => {
      if (path.resolve(String(requested)) === file) {
        if (!swapped) {
          swapped = true;
          await fs.unlink(file);
          execFileSync('mkfifo', [file], { timeout: 1000, windowsHide: true });
          // A deliberately blocking predecessor control is released so a failed
          // regression cannot leave libuv's open pending or hang the test process.
          timer = setTimeout(() => {
            watchdogReleased = true;
            const writer = native.openSync(file, native.constants.O_WRONLY | native.constants.O_NONBLOCK);
            native.closeSync(writer);
          }, 750);
        }
        actualFlags = forceBlocking ? flags & ~native.constants.O_NONBLOCK : flags;
        const handle = await originalOpen(requested, actualFlags, mode);
        const close = handle.close.bind(handle);
        handle.close = async () => { closedDescriptors += 1; await close(); };
        return handle;
      }
      return originalOpen(requested, flags, mode);
    };
    try { await readStableFile(file, 64); }
    catch (error) { denied = error.message === 'File read unavailable'; }
    return { denied, swapped, watchdogReleased, closedDescriptors, actualFlags,
      nonblocking: Boolean(actualFlags & native.constants.O_NONBLOCK), elapsedMs: performance.now() - started };
  } finally {
    fs.open = originalOpen;
    clearTimeout(timer);
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('flujo-stable-fifo-')) {
      throw new Error('Unsafe FIFO fixture cleanup');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }
};
