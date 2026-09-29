'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const artifacts = require('./artifacts.json');
let verified;

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
  const descriptor = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha512');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
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
    const stat = fs.lstatSync(location.binary);
    const receiptStat = fs.lstatSync(location.receipt);
    const root = fs.realpathSync(__dirname);
    const relativeBinary = path.relative(__dirname, location.binary);
    const relativeReceipt = path.relative(__dirname, location.receipt);
    if (!stat.isFile() || !receiptStat.isFile()
      || fs.realpathSync(location.binary) !== path.join(root, relativeBinary)
      || fs.realpathSync(location.receipt) !== path.join(root, relativeReceipt)) {
      throw new Error('Executable cache escaped the package');
    }
    const receipt = JSON.parse(fs.readFileSync(location.receipt, 'utf8'));
    const expected = artifacts.platforms[location.platform];
    if (!stat.isFile() || receipt.version !== artifacts.version || receipt.platform !== location.platform
      || receipt.artifactSha512 !== expected.sha512 || !/^[a-f0-9]{128}$/.test(receipt.binarySha512)) {
      throw new Error('Invalid verification receipt');
    }
    const identity = `${location.binary}:${stat.size}:${stat.mtimeMs}:${receipt.binarySha512}`;
    if (verified !== identity) {
      const checksum = sha512(location.binary);
      if (checksum !== receipt.binarySha512 || (process.platform === 'win32' && checksum !== expected.sha512)) {
        throw new Error('Executable checksum changed');
      }
      verified = identity;
    }
    return location.binary;
  } catch {
    throw new Error(`The verified Antigravity CLI ${artifacts.version} runtime is missing or changed. Run npm rebuild @flujo-ai/antigravity-cli in the FLUJO installation, then restart FLUJO.`);
  }
}

module.exports = { resolveBinary, version: artifacts.version, platformKey, paths, sha512 };
