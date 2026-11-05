/**
 * The launcher's side of the optional unattended unlock, and the
 * `flujo unlock-secret` command that stores a secret with Windows DPAPI.
 *
 * Off by default: FLUJO_UNLOCK_SECRET_SOURCE selects a source.
 *   env     FLUJO_UNLOCK_SECRET comes from a protected place, such as systemd
 *           credentials. A value that came from a .env file is refused, because that
 *           file sits next to the data it is supposed to protect.
 *   dpapi   FLUJO_UNLOCK_SECRET_FILE names a file outside the data directory holding
 *           the secret encrypted by Windows. It is only readable on this PC.
 *
 * The secret never appears on a command line, and never in a message or a log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  absoluteDirectory, CliError, defaultServiceRoot, isSameOrInside, report, runProgram, validateServiceName,
  windowsSystemProgram, writeJsonAtomicSync,
} from './common.mjs';
import { readServiceRecord } from './managed-root.mjs';

export const SECRET_VARIABLE = 'FLUJO_UNLOCK_SECRET';
export const CHECKED_VARIABLE = 'FLUJO_UNLOCK_SECRET_CHECKED';
export const SOURCE_VARIABLE = 'FLUJO_UNLOCK_SECRET_SOURCE';
export const FILE_VARIABLE = 'FLUJO_UNLOCK_SECRET_FILE';
const SCOPES = { user: 'CurrentUser', machine: 'LocalMachine' };
/** Same size limit as a password field, and a stored blob is a little larger. */
const MAX_SECRET_BYTES = 4096;
const MAX_FILE_BYTES = 64 * 1024;

function dpapi(action, scope, input, { run = runProgram } = {}) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    `$scope = [Security.Cryptography.DataProtectionScope]::${SCOPES[scope]}`,
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$out = [Security.Cryptography.ProtectedData]::${action}($in, $null, $scope)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
  const result = run(windowsSystemProgram('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { input, timeout: 60_000 });
  return result.ok && result.stdout ? result.stdout.trim() : null;
}

export function protectSecret(secret, scope = 'user', options) {
  return dpapi('Protect', scope, Buffer.from(secret, 'utf8').toString('base64'), options);
}

export function readProtectedSecret(file, options) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return null;
  let stored;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
  if (stored?.format !== 'flujo-unlock-secret' || !SCOPES[stored.scope] || typeof stored.blob !== 'string') return null;
  const plain = dpapi('Unprotect', stored.scope, stored.blob, options);
  return plain ? Buffer.from(plain, 'base64').toString('utf8') : null;
}

/**
 * Decide what the server gets. Returns the settled environment changes and, if
 * something is wrong, one fixed message. Whatever goes wrong, the result is only
 * that the instance stays locked: it still starts and someone can still unlock it.
 */
export function resolveUnlockSecret(env, { loadedFromFile = false, platform = process.platform, readSecret = readProtectedSecret } = {}) {
  const source = env[SOURCE_VARIABLE]?.trim().toLowerCase();
  // Only this function may set the checked value, whatever the environment says.
  delete env[CHECKED_VARIABLE];
  if (!source || source === 'off') {
    // Not opted in: a secret lying around must have no effect at all.
    delete env[SECRET_VARIABLE];
    return { enabled: false };
  }
  if (source === 'env') {
    if (loadedFromFile) {
      delete env[SECRET_VARIABLE];
      return { enabled: true, problem: 'The unlock secret was found in a .env file next to the data, which would defeat its purpose. It was ignored, and FLUJO stays locked.' };
    }
    if (!env[SECRET_VARIABLE]) return { enabled: true, problem: 'No unlock secret was provided, so FLUJO stays locked.' };
    env[CHECKED_VARIABLE] = env[SECRET_VARIABLE];
    delete env[SECRET_VARIABLE];
    return { enabled: true };
  }
  if (source === 'dpapi') {
    delete env[SECRET_VARIABLE];
    if (platform !== 'win32') return { enabled: true, problem: 'DPAPI exists only on Windows, so FLUJO stays locked.' };
    const file = env[FILE_VARIABLE];
    if (!file || !path.isAbsolute(file)) return { enabled: true, problem: `${FILE_VARIABLE} must be a full path, so FLUJO stays locked.` };
    if (env.FLUJO_DATA_DIR && isSameOrInside(env.FLUJO_DATA_DIR, file)) {
      return { enabled: true, problem: 'The unlock secret file must be outside the data directory, so FLUJO stays locked.' };
    }
    const secret = readSecret(file);
    if (!secret) return { enabled: true, problem: 'Windows could not open the unlock secret for this account, so FLUJO stays locked. See docs/operations/unattended-unlock.md.' };
    env[CHECKED_VARIABLE] = secret;
    return { enabled: true };
  }
  delete env[SECRET_VARIABLE];
  return { enabled: true, problem: `${SOURCE_VARIABLE} must be off, env or dpapi, so FLUJO stays locked.` };
}

/** True if any loaded .env file defines the secret. Reads Next's load result. */
export function secretCameFromFile(loaded) {
  return (loaded?.loadedEnvFiles ?? []).some(file => {
    const value = file?.env?.[SECRET_VARIABLE];
    return value !== undefined && value !== '';
  });
}

const USAGE = `Usage:
  flujo unlock-secret set --name <instance> [--scope user|machine] [--root <folder>] [--json]   (reads the secret from standard input)
  flujo unlock-secret check --name <instance> [--root <folder>] [--json]
  flujo unlock-secret clear --name <instance> [--root <folder>] [--json]

Stores the password of a locked instance, encrypted by Windows, so the instance can
start with nobody present. See docs/operations/unattended-unlock.md.`;

const OPTIONS = {
  name: { type: 'string' },
  scope: { type: 'string', default: 'user' },
  root: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

export const secretFileFor = root => path.join(root, 'unlock-secret.json');

function readAllInput() {
  const chunks = [];
  const buffer = Buffer.alloc(8192);
  let total = 0;
  for (;;) {
    let read;
    try { read = fs.readSync(0, buffer); }
    catch (error) {
      if (error.code === 'EOF') break;
      if (error.code === 'EAGAIN') continue;
      throw error;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    total += read;
    if (total > MAX_SECRET_BYTES + 2) throw new CliError('The secret is too long.');
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export async function main(argv, { readInput = readAllInput, platform = process.platform } = {}) {
  const [action, ...rest] = argv;
  let values;
  try { ({ values } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: false })); }
  catch { throw new CliError(USAGE); }
  if (values.help || !['set', 'check', 'clear'].includes(action)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const name = validateServiceName(values.name);
  const root = values.root ? absoluteDirectory(values.root, '--root') : defaultServiceRoot(name);
  const file = secretFileFor(root);
  if (action === 'clear') {
    fs.rmSync(file, { force: true });
    report({ name, cleared: true }, values.json, ['The stored unlock secret is removed.']);
    return 0;
  }
  if (platform !== 'win32') throw new CliError('This command uses Windows DPAPI. On Linux, use FLUJO_UNLOCK_SECRET_SOURCE=env with a protected source; see docs/operations/unattended-unlock.md.');
  if (action === 'check') {
    const readable = Boolean(fs.existsSync(file) && readProtectedSecret(file));
    report({ name, stored: fs.existsSync(file), readable }, values.json, [readable ? 'This account can open the stored unlock secret.' : 'This account cannot open a stored unlock secret here.']);
    return readable ? 0 : 1;
  }
  if (!SCOPES[values.scope]) throw new CliError('--scope must be user or machine.');
  const record = readServiceRecord(root);
  if (record && isSameOrInside(record.dataDir, file)) throw new CliError('The unlock secret file must be outside the data directory.');
  const secret = readInput();
  if (!secret) throw new CliError('No secret was given on standard input.');
  const blob = protectSecret(secret, values.scope);
  if (!blob) throw new CliError('Windows could not encrypt the secret.');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeJsonAtomicSync(file, { format: 'flujo-unlock-secret', version: 1, scope: values.scope, blob });
  report({ name, file, scope: values.scope }, values.json, [
    `Stored, encrypted by Windows for ${values.scope === 'machine' ? 'this PC' : 'this user on this PC'}.`,
    `Now set in the instance's .env file: ${SOURCE_VARIABLE}=dpapi and ${FILE_VARIABLE}=${file}`,
  ]);
  return 0;
}
