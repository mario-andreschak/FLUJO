'use strict';

// Resolve Google's official CLI, including a freshly installed Windows CLI
// that is not yet visible in this process's inherited PATH. No FLUJO shim.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const minimumVersion = '1.3.3';
let installation;
let verified;

function candidates(env = process.env, platform = process.platform, home = os.homedir()) {
  const name = platform === 'win32' ? 'agy.exe' : 'agy';
  const known = platform === 'win32'
    ? [path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'agy', 'bin', name)]
    : [path.join(home, '.local', 'bin', name), path.join(home, '.agy', 'bin', name)];
  return [...new Set([...known, ...(env.PATH || env.Path || '').split(path.delimiter)
    .filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, name))])];
}

function findBinary() {
  return candidates().find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
}

function supportedVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return Boolean(match && Number(match[1]) === 1
    && (Number(match[2]) > 3 || (Number(match[2]) === 3 && Number(match[3]) >= 3)));
}

async function qualify(binary) {
  const stat = fs.statSync(binary, { bigint: true });
  const identity = `${binary}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (verified?.identity === identity) return verified;
  const options = { timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } };
  const version = (await run(binary, ['--version'], options)).stdout.trim();
  if (!supportedVersion(version)) throw new Error('Update the official Antigravity CLI to a supported version (1.3.3 or newer in the 1.x series).');
  const result = await run(binary, ['--input-format', 'stream-json', '--output-format', 'stream-json',
    '--agent', 'flujo', '--disable-slash-commands', '--print-timeout', '1m', '--help'], options);
  const help = result.stdout + result.stderr;
  for (const flag of ['--input-format', '--output-format', '--agent', '--disable-slash-commands', '--print-timeout']) {
    if (!help.includes(flag)) throw new Error('This Antigravity CLI does not support the required FLUJO integration. Update the CLI and FLUJO.');
  }
  verified = { identity, binary, version };
  return verified;
}

async function install() {
  const options = { timeout: 240000, maxBuffer: 1024 * 1024, windowsHide: true };
  // Only fixed vendor URLs and fixed commands; never interpolate request data.
  if (process.platform === 'win32') {
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; irm https://antigravity.google/cli/install.ps1 | iex"], options);
  } else if (['linux', 'darwin'].includes(process.platform)) {
    await run('/bin/bash', ['-o', 'pipefail', '-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'], options);
  } else {
    throw new Error('Antigravity CLI supports Windows, macOS and Linux.');
  }
}

async function resolveBinary() {
  let binary = findBinary();
  if (!binary) {
    if (!installation) installation = install().finally(() => { installation = undefined; });
    try { await installation; } catch {
      throw new Error('Could not install the official Antigravity CLI. Check internet access and installation permissions, then retry, or install it from https://antigravity.google/cli.');
    }
    binary = findBinary();
  }
  if (!binary) throw new Error('Antigravity CLI was not found after installation. Install agy for the operating-system user running FLUJO, then retry.');
  try { await qualify(binary); } catch (error) {
    if (/^Update the official|^This Antigravity/.test(error.message)) throw error;
    throw new Error('The official Antigravity CLI could not start. Repair its installation and retry.');
  }
  return binary;
}

module.exports = { candidates, findBinary, resolveBinary, supportedVersion, minimumVersion };
