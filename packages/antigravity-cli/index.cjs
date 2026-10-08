'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const artifacts = require('./artifacts.json');
let verified;

function sameFile(first, second, pathToDescriptor = false) {
  // Windows' GetFileInformationByName path stat can omit the volume serial,
  // while descriptor stat obtains it through NtQueryVolumeInformationFile.
  // Keep descriptor-to-descriptor and path-to-path device checks exact.
  const sameDevice = first.dev === second.dev || (pathToDescriptor && process.platform === 'win32'
    && (first.dev === 0n || second.dev === 0n));
  return sameDevice && ['ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink']
    .every(name => first[name] === second[name]);
}

function readReceipt(file, expected) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  let bytes;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > 65536n || !sameFile(expected, opened, true)) {
      throw new Error('Verification receipt changed');
    }
    bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (BigInt(length) !== opened.size || !sameFile(opened, fs.fstatSync(descriptor, { bigint: true }))
      || !sameFile(opened, fs.lstatSync(file, { bigint: true }), true)) throw new Error('Verification receipt changed');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally {
    bytes?.fill(0);
    fs.closeSync(descriptor);
  }
}

function platformKey() {
  const architecture = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!architecture || !['win32', 'linux', 'darwin'].includes(process.platform)) {
    throw new Error(`Antigravity CLI does not support ${process.platform}/${process.arch}. Use Windows, macOS or Linux on x64/arm64.`);
  }
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  let musl = false;
  if (os === 'linux') {
    musl = !process.report.getReport().header.glibcVersionRuntime;
  }
  return `${os}_${architecture}${musl ? '_musl' : ''}`;
}

function sha512(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  const hash = crypto.createHash('sha512');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(opened, fs.lstatSync(file, { bigint: true }), true)) {
      throw new Error('Executable changed');
    }
    let length = 0;
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      length += count;
      if (BigInt(length) > opened.size) throw new Error('Executable changed');
      hash.update(buffer.subarray(0, count));
    }
    if (BigInt(length) !== opened.size || !sameFile(opened, fs.fstatSync(descriptor, { bigint: true }))
      || !sameFile(opened, fs.lstatSync(file, { bigint: true }), true)) throw new Error('Executable changed');
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
    fs.closeSync(descriptor);
  }
}

function paths() {
  const platform = platformKey();
  const directory = path.join(__dirname, '.cache', artifacts.version, platform);
  return {
    platform, directory,
    binary: path.join(directory, process.platform === 'win32' ? 'agy.exe' : 'agy'),
    receipt: path.join(directory, 'verified.json'),
  };
}

function resolveBinary() {
  const location = paths();
  try {
    const stat = fs.lstatSync(location.binary, { bigint: true });
    const receiptStat = fs.lstatSync(location.receipt, { bigint: true });
    const root = fs.realpathSync(__dirname);
    const relativeBinary = path.relative(__dirname, location.binary);
    const relativeReceipt = path.relative(__dirname, location.receipt);
    if (!stat.isFile() || !receiptStat.isFile()
      || fs.realpathSync(location.binary) !== path.join(root, relativeBinary)
      || fs.realpathSync(location.receipt) !== path.join(root, relativeReceipt)) {
      throw new Error('Executable cache escaped the package');
    }
    const receipt = readReceipt(location.receipt, receiptStat);
    const expected = artifacts.platforms[location.platform];
    if (!stat.isFile() || receipt.version !== artifacts.version || receipt.platform !== location.platform
      || receipt.artifactSha512 !== expected.sha512 || !/^[a-f0-9]{128}$/.test(receipt.binarySha512)) {
      throw new Error('Invalid verification receipt');
    }
    const identity = `${location.binary}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.nlink}:${receipt.binarySha512}`;
    if (verified !== identity) {
      const checksum = sha512(location.binary);
      if (checksum !== receipt.binarySha512 || (process.platform === 'win32' && checksum !== expected.sha512)) {
        throw new Error('Executable checksum changed');
      }
      verified = identity;
    }
    if (!sameFile(stat, fs.lstatSync(location.binary, { bigint: true }))
      || !sameFile(receiptStat, fs.lstatSync(location.receipt, { bigint: true }))
      || fs.realpathSync(location.binary) !== path.join(root, relativeBinary)
      || fs.realpathSync(location.receipt) !== path.join(root, relativeReceipt)) throw new Error('Executable cache changed');
    return location.binary;
  } catch {
    throw new Error(`The verified Antigravity CLI ${artifacts.version} runtime is missing or changed. Run npm rebuild @flujo-ai/antigravity-cli in the FLUJO installation, then restart FLUJO.`);
  }
}

module.exports = { resolveBinary, version: artifacts.version, platformKey, paths, sha512 };
