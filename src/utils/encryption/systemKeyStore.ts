import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The operating system's own protected store for FLUJO's system key (#1443):
 * Windows data protection (DPAPI), the macOS Keychain or the Linux Secret
 * Service. Each one uses the tool that comes with the system, so FLUJO needs
 * no extra package and no native build. Where none of them works, FLUJO keeps
 * today's protection.
 *
 * Only fixed programs at fixed paths are started, with fixed arguments and
 * without a shell. The secret travels on standard input, never on the command
 * line, where other programs could read it.
 *
 * `FLUJO_SYSTEM_KEY_STORE=off` turns the system store off (tests and servers
 * that manage keys themselves).
 */

export type SystemKeyStoreKind = 'windows' | 'macos' | 'linux';

export interface SystemKeyStore {
  readonly kind: SystemKeyStoreKind;
  /**
   * Keeps `secret` under `id`. Returns the protected copy that FLUJO must keep
   * itself when the store hands one back (Windows), otherwise `undefined`.
   */
  save(id: string, secret: string): Promise<string | undefined>;
  /** The secret kept under `id`, or `null` when the store holds none. */
  load(id: string, protectedCopy: string | undefined): Promise<string | null>;
}

/** The store could not be reached just now (tool missing, slow, keychain locked). Trying again may help. */
export class SystemKeyStoreUnavailableError extends Error {
  constructor(readonly kind: SystemKeyStoreKind, detail: string) {
    super(`${storeLabel(kind)} did not answer: ${detail}`);
    this.name = 'SystemKeyStoreUnavailableError';
  }
}

/** The store answered but cannot open FLUJO's key for this user, for example after a Windows password reset. */
export class SystemKeyUnreadableError extends Error {
  constructor(readonly kind: SystemKeyStoreKind) {
    super(`${storeLabel(kind)} can no longer open FLUJO's key for this user account`);
    this.name = 'SystemKeyUnreadableError';
  }
}

export function storeLabel(kind: SystemKeyStoreKind): string {
  return kind === 'windows' ? 'Windows' : kind === 'macos' ? 'The macOS Keychain' : 'The system keyring';
}

const TIMEOUT_MS = 30_000;
const ID = /^[a-f0-9-]{36}$/;
const SECRET = /^[A-Za-z0-9_-]{43,512}$/;

interface RunResult { code: number; stdout: string; stderr: string }

function run(kind: SystemKeyStoreKind, file: string, args: string[], input: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) { resolve({ code: 0, stdout, stderr }); return; }
        if (typeof error.code === 'number' && !error.killed) { resolve({ code: error.code, stdout, stderr }); return; }
        reject(new SystemKeyStoreUnavailableError(kind, error.killed ? 'it took too long' : `could not start ${path.basename(file)}`));
      });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

function checkId(id: string): void {
  if (!ID.test(id)) throw new Error('Invalid system key id');
}

function checkSecret(kind: SystemKeyStoreKind, secret: string): string {
  if (!SECRET.test(secret)) throw new SystemKeyUnreadableError(kind);
  return secret;
}

// Windows data protection, bound to this Windows user account. The extra
// "entropy" ties a protected copy to its key id. Exit 3 means "this user
// cannot open it"; exit 4 means the protection API is not available.
const DPAPI_SCRIPT = (method: 'Protect' | 'Unprotect') => [
  "$ErrorActionPreference = 'Stop'",
  'try { Add-Type -AssemblyName System.Security } catch { exit 4 }',
  '$lines = [Console]::In.ReadToEnd() -split "`n"',
  '$data = [Convert]::FromBase64String($lines[0].Trim())',
  '$entropy = [Text.Encoding]::UTF8.GetBytes($lines[1].Trim())',
  '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
  `try { $out = [Security.Cryptography.ProtectedData]::${method}($data, $entropy, $scope) }`,
  'catch [Security.Cryptography.CryptographicException] { exit 3 }',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('\n');

function windowsStore(): SystemKeyStore {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const call = async (method: 'Protect' | 'Unprotect', data: string, id: string): Promise<string> => {
    const encoded = Buffer.from(DPAPI_SCRIPT(method), 'utf16le').toString('base64');
    const result = await run('windows', powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      `${data}\nflujo:system-key:v1:${id}\n`);
    if (result.code === 3) throw new SystemKeyUnreadableError('windows');
    if (result.code !== 0) throw new SystemKeyStoreUnavailableError('windows', 'Windows data protection is not available');
    return result.stdout.trim();
  };
  return {
    kind: 'windows',
    async save(id, secret) {
      checkId(id);
      return call('Protect', Buffer.from(checkSecret('windows', secret)).toString('base64'), id);
    },
    async load(id, protectedCopy) {
      checkId(id);
      if (!protectedCopy) return null;
      return checkSecret('windows', Buffer.from(await call('Unprotect', protectedCopy, id), 'base64').toString('utf8'));
    },
  };
}

const KEYCHAIN_SERVICE = 'flujo-system-key';
/** `security` exit status for "The specified item could not be found in the keychain." */
const KEYCHAIN_NOT_FOUND = 44;

function macosStore(): SystemKeyStore {
  const security = '/usr/bin/security';
  return {
    kind: 'macos',
    async save(id, secret) {
      checkId(id);
      // Interactive mode reads the command from standard input, so the secret
      // never appears in the process list.
      const result = await run('macos', security, ['-i'],
        `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${id} -l FLUJO -w ${checkSecret('macos', secret)}\n`);
      // The caller reads the key back, so a refusal reported only as text is caught there.
      if (result.code !== 0) throw new SystemKeyStoreUnavailableError('macos', 'the Keychain refused the key');
      return undefined;
    },
    async load(id) {
      checkId(id);
      const result = await run('macos', security, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id, '-w'], '');
      if (result.code === KEYCHAIN_NOT_FOUND) return null;
      if (result.code !== 0) throw new SystemKeyStoreUnavailableError('macos', 'the Keychain is locked or not reachable');
      return checkSecret('macos', result.stdout.trim());
    },
  };
}

/** The Secret Service through `secret-tool` at `secretTool` (libsecret). */
export function secretServiceStore(secretTool: string): SystemKeyStore {
  const attributes = (id: string) => ['application', 'flujo', 'flujo-system-key', id];
  // `search` lists a matching item even while its keyring is locked, without
  // asking to unlock it. It prints the item's attributes on standard error.
  const listed = async (id: string): Promise<boolean> => {
    const result = await run('linux', secretTool, ['search', ...attributes(id)], '');
    if (result.code !== 0) throw new SystemKeyStoreUnavailableError('linux', 'the keyring is not reachable');
    return `${result.stdout}\n${result.stderr}`.split('\n').some(line => line.trim() === `attribute.flujo-system-key = ${id}`);
  };
  return {
    kind: 'linux',
    async save(id, secret) {
      checkId(id);
      const result = await run('linux', secretTool, ['store', '--label', 'FLUJO system key', ...attributes(id)], checkSecret('linux', secret));
      if (result.code !== 0) throw new SystemKeyStoreUnavailableError('linux', 'the keyring refused the key');
      return undefined;
    },
    async load(id) {
      checkId(id);
      const result = await run('linux', secretTool, ['lookup', ...attributes(id)], '');
      if (result.code === 0) return checkSecret('linux', result.stdout.trim());
      // secret-tool answers both "nothing found" and "found, but the keyring
      // is locked" with exit 1 and no message. A locked key is not a lost key.
      if (result.code !== 1 || result.stderr.trim()) throw new SystemKeyStoreUnavailableError('linux', 'the keyring is not reachable');
      if (await listed(id)) throw new SystemKeyStoreUnavailableError('linux', 'the keyring is locked');
      return null;
    },
  };
}

async function executable(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); }
  catch { return false; }
}

declare global {
  var __flujo_system_key_store_override: { store: SystemKeyStore | null } | undefined;
  var __flujo_system_key_store_detected: { setting: string; checkedAt: number; store: Promise<SystemKeyStore | null> } | undefined;
}

/** Tests only: use this store (or none) instead of the real one. `undefined` restores normal detection. */
export function setSystemKeyStoreForTests(store: SystemKeyStore | null | undefined): void {
  global.__flujo_system_key_store_override = store === undefined ? undefined : { store };
}

/** A keyring that appears later (for example after a desktop login) is noticed within this time. */
const REDETECT_MS = 5 * 60_000;

/** The store FLUJO can use on this computer, or `null` when there is none. */
export function detectSystemKeyStore(): Promise<SystemKeyStore | null> {
  const override = global.__flujo_system_key_store_override;
  if (override) return Promise.resolve(override.store);
  const setting = (process.env.FLUJO_SYSTEM_KEY_STORE ?? '').trim().toLowerCase();
  const cached = global.__flujo_system_key_store_detected;
  if (cached && cached.setting === setting && Date.now() - cached.checkedAt < REDETECT_MS) return cached.store;
  const store = setting === 'off' ? Promise.resolve(null) : detect();
  global.__flujo_system_key_store_detected = { setting, checkedAt: Date.now(), store };
  return store;
}

async function detect(): Promise<SystemKeyStore | null> {
  if (process.platform === 'win32') return windowsStore();
  if (process.platform === 'darwin') return await executable('/usr/bin/security') ? macosStore() : null;
  if (process.platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS) {
    for (const candidate of ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool']) {
      if (await executable(candidate)) return secretServiceStore(candidate);
    }
  }
  return null;
}
