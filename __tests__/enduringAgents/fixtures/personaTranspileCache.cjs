'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs && first.nlink === second.nlink;
}

function createTranspileCache(ts, requestedDirectory) {
  let directory;
  let admittedDirectory;
  try {
    directory = requestedDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-persona-transpile-'));
    if (!requestedDirectory) fs.chmodSync(directory, 0o700);
    // An explicit shared cache is created privately by the parent harness, never
    // adopted from a predictable machine-wide directory or created recursively.
    admittedDirectory = fs.lstatSync(directory);
    if (!admittedDirectory.isDirectory() || admittedDirectory.isSymbolicLink()
        || (process.platform !== 'win32' && ((admittedDirectory.mode & 0o077) !== 0
          || admittedDirectory.uid !== process.getuid()))) directory = undefined;
  } catch { directory = undefined; }

  function checkDirectory() {
    const current = fs.lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink()
        || current.dev !== admittedDirectory.dev || current.ino !== admittedDirectory.ino
        || (process.platform !== 'win32' && ((current.mode & 0o077) !== 0 || current.uid !== process.getuid()))) throw new Error('Unsafe transpile cache');
  }

  return function transpileCached(variant, filename, source, compilerOptions) {
    const compile = () => ts.transpileModule(source, { compilerOptions, fileName: filename }).outputText;
    if (!directory) return compile();
    const key = crypto.createHash('sha256').update(JSON.stringify([ts.version, variant, filename, compilerOptions, source])).digest('hex');
    const cacheFile = path.join(directory, `${key}.js`);
    let descriptor;
    try {
      checkDirectory();
      descriptor = fs.openSync(cacheFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const opened = fs.fstatSync(descriptor);
      const named = fs.lstatSync(cacheFile);
      if (!opened.isFile() || named.isSymbolicLink() || opened.nlink !== 1 || !sameFile(opened, named)
          || opened.size > 8 * 1024 * 1024 || (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)) throw new Error('Unsafe cached code');
      const bytes = Buffer.alloc(opened.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(descriptor, bytes, count, bytes.length - count, count);
        if (!read) break;
        count += read;
      }
      if (count !== opened.size || !sameFile(opened, fs.fstatSync(descriptor)) || !sameFile(opened, fs.lstatSync(cacheFile))) throw new Error('Cached code changed');
      checkDirectory();
      return bytes.subarray(0, count).toString('utf8');
    } catch {
      // Unsafe cache entries are misses; only freshly compiled source executes.
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    const output = compile();
    const temporary = path.join(directory, `.compile-${crypto.randomUUID()}.tmp`);
    let created = false;
    try {
      checkDirectory();
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      created = true;
      try { fs.writeFileSync(descriptor, output, 'utf8'); }
      finally { fs.closeSync(descriptor); }
      checkDirectory();
      fs.renameSync(temporary, cacheFile);
      created = false;
    } catch {
      if (created) {
        try { fs.unlinkSync(temporary); } catch { /* private owned cache candidate */ }
      }
    }
    return output;
  };
}

module.exports = { createTranspileCache };
