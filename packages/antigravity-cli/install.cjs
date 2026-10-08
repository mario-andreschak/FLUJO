'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const artifacts = require('./artifacts.json');
const { paths, sha512, resolveBinary } = require('./index.cjs');

// Read only the verified archive's regular root executable. No archive path is
// ever joined to a destination and no symlink or executable installer is run.
async function extractBinary(archive, destination) {
  const input = fs.createReadStream(archive).pipe(zlib.createGunzip());
  let buffer = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let selected = false;
  let found = false;
  let expanded = 0;
  let output;
  try {
    for await (const chunk of input) {
      expanded += chunk.length;
      if (expanded > 1024 * 1024 * 1024) throw new Error('Antigravity archive exceeded its extraction limit');
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (remaining) {
          const length = Math.min(remaining, buffer.length);
          if (selected) await output.write(buffer.subarray(0, length));
          buffer = buffer.subarray(length);
          remaining -= length;
          continue;
        }
        if (padding) {
          const length = Math.min(padding, buffer.length);
          buffer = buffer.subarray(length);
          padding -= length;
          continue;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every(byte => byte === 0)) continue;
        const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
        const prefix = header.subarray(345, 500).toString('utf8').split('\0')[0];
        const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim();
        if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid Antigravity archive size');
        remaining = parseInt(sizeText, 8);
        if (!Number.isSafeInteger(remaining) || remaining > 1024 * 1024 * 1024) throw new Error('Invalid Antigravity archive member');
        padding = (512 - remaining % 512) % 512;
        selected = name === 'antigravity' && !prefix;
        if (selected) {
          if (found || ![0, 48].includes(header[156])) throw new Error('Unexpected Antigravity executable archive entry');
          found = true;
          output = await fsp.open(destination, 'wx', 0o700);
        }
      }
    }
    if (!found || remaining || padding) throw new Error('Incomplete Antigravity executable archive');
  } finally {
    if (output) await output.close();
    input.destroy();
  }
}

async function install() {
  try { resolveBinary(); return; } catch { /* Download a missing or invalid cache. */ }
  const location = paths();
  const artifact = artifacts.platforms[location.platform];
  const packageRoot = await fsp.realpath(__dirname);
  let cacheDirectory = __dirname;
  for (const component of ['.cache', artifacts.version, location.platform]) {
    cacheDirectory = path.join(cacheDirectory, component);
    try { await fsp.mkdir(cacheDirectory, { mode: 0o755 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fsp.lstat(cacheDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || await fsp.realpath(cacheDirectory) !== path.join(packageRoot, path.relative(__dirname, cacheDirectory))) {
      throw new Error('Antigravity installation cache escaped the package');
    }
  }
  const staging = await fsp.mkdtemp(path.join(location.directory, 'install-'));
  try {
    const payload = path.join(staging, 'payload');
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Google artifact download failed (${response.status})`);
    const handle = await fsp.open(payload, 'wx', 0o600);
    const hash = crypto.createHash('sha512');
    let received = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        received += chunk.length;
        if (received > 1024 * 1024 * 1024) throw new Error('Antigravity download exceeded its size limit');
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally { await handle.close(); }
    if (hash.digest('hex') !== artifact.sha512) throw new Error('Google Antigravity artifact checksum mismatch');
    const binary = path.join(staging, 'agy');
    if (process.platform === 'win32') await fsp.rename(payload, binary);
    else await extractBinary(payload, binary);
    const receipt = {
      version: artifacts.version, platform: location.platform,
      artifactSha512: artifact.sha512, binarySha512: sha512(binary),
    };
    await fsp.chmod(binary, 0o555);
    await fsp.rm(location.binary, { force: true });
    await fsp.rename(binary, location.binary);
    await fsp.chmod(location.binary, 0o555);
    const receiptPath = path.join(staging, 'verified.json');
    await fsp.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o644 });
    await fsp.rename(receiptPath, location.receipt);
    resolveBinary();
    process.stdout.write(`Verified Google Antigravity CLI ${artifacts.version} (${location.platform})\n`);
  } finally {
    // mkdtemp created this exact path inside the package-owned platform cache.
    if (path.dirname(staging) !== location.directory) throw new Error('Invalid installation staging directory');
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

if (require.main === module) install().catch(error => {
  process.stderr.write(`Antigravity CLI installation failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { install, extractBinary };
