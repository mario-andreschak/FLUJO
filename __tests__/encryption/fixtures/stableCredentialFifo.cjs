const native = require('node:fs');
const fs = native.promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function withOwnedFixture(action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-private-readers-'));
  const saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_ENCRYPTION_PASSPHRASE_FILE']
    .map(key => [key, process.env[key]]));
  const files = { operator: path.join(directory, 'operator'), json: path.join(directory, 'metadata.json') };
  try {
    process.env.FLUJO_DATA_DIR = path.join(directory, 'data');
    delete process.env.FLUJO_PARENT_DATA_DIR;
    process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = files.operator;
    await fs.mkdir(process.env.FLUJO_DATA_DIR);
    await fs.writeFile(files.operator, 'synthetic-private-passphrase-with-32-characters\n', { mode: 0o600 });
    await fs.writeFile(files.json, '{"fixture":"safe"}', { mode: 0o600 });
    return await action(files);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir())
        || !path.basename(resolved).startsWith('flujo-private-readers-')) {
      throw new Error('Unsafe private-reader fixture cleanup');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

/** Replace only the owned regular file, immediately before the actual reader opens it. */
async function probeFifo(read, kind, expectedError, forceBlocking = false) {
  return withOwnedFixture(async files => {
    const file = files[kind];
    const originalOpen = fs.open;
    let timer;
    let swapped = false;
    let watchdogReleased = false;
    let closedDescriptors = 0;
    let readCalls = 0;
    let denied = false;
    let actualFlags;
    const started = performance.now();
    try {
      fs.open = async (requested, flags, mode) => {
        if (path.resolve(String(requested)) !== file) return originalOpen(requested, flags, mode);
        if (!swapped) {
          swapped = true;
          await fs.unlink(file);
          execFileSync('mkfifo', ['-m', '600', file], { timeout: 1000, windowsHide: true });
          // Bound the blocking negative control and regressions in the actual reader.
          timer = setTimeout(() => {
            watchdogReleased = true;
            const writer = native.openSync(file, native.constants.O_WRONLY | native.constants.O_NONBLOCK);
            native.closeSync(writer);
          }, 750);
        }
        actualFlags = forceBlocking && typeof flags === 'number' ? flags & ~native.constants.O_NONBLOCK : flags;
        const handle = await originalOpen(requested, actualFlags, mode);
        const close = handle.close.bind(handle);
        const readBytes = handle.read.bind(handle);
        handle.close = async () => { closedDescriptors += 1; await close(); };
        handle.read = async (...args) => { readCalls += 1; return readBytes(...args); };
        return handle;
      };
      try { await read(file); }
      catch (error) { denied = error.message === expectedError; }
      return { denied, swapped, watchdogReleased, closedDescriptors, readCalls,
        nonblocking: typeof actualFlags === 'number' && Boolean(actualFlags & native.constants.O_NONBLOCK),
        elapsedMs: performance.now() - started };
    } finally {
      fs.open = originalOpen;
      clearTimeout(timer);
    }
  });
}

/** Swap two simultaneously existing regular files, avoiding inode reuse. */
async function probeReplacement(read, kind, expectedError, afterRead) {
  return withOwnedFixture(async files => {
    const file = files[kind];
    const replacement = `${file}.replacement`;
    await fs.writeFile(replacement, await fs.readFile(file), { mode: 0o600 });
    const originalOpen = fs.open;
    let swapped = false;
    let closedDescriptors = 0;
    let readCalls = 0;
    let denied = false;
    const swap = async () => {
      await fs.rename(file, `${file}.old`);
      await fs.rename(replacement, file);
      swapped = true;
    };
    try {
      fs.open = async (requested, flags, mode) => {
        if (path.resolve(String(requested)) !== file) return originalOpen(requested, flags, mode);
        if (!afterRead) await swap();
        const handle = await originalOpen(requested, flags, mode);
        const close = handle.close.bind(handle);
        const readBytes = handle.read.bind(handle);
        handle.close = async () => { closedDescriptors += 1; await close(); };
        handle.read = async (...args) => {
          const result = await readBytes(...args);
          readCalls += 1;
          if (afterRead && !swapped) await swap();
          return result;
        };
        return handle;
      };
      try { await read(file); }
      catch (error) { denied = error.message === expectedError; }
      return { denied, swapped, closedDescriptors, readCalls };
    } finally {
      fs.open = originalOpen;
    }
  });
}

module.exports = { withOwnedFixture, probeFifo, probeReplacement };
