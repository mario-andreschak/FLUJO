import { constants, promises as fs, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const unsafe = () => new Error('Private storage is unavailable or has unsafe ownership, permissions, or links.');

// Pass only the path/action in the child environment. No secret contents enter
// PowerShell arguments, output, or error messages. ACLs are owner-only on Windows;
// chmod(0600) alone would not restrict Windows readers.
const windowsAclScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $p = [Environment]::GetEnvironmentVariable('FLUJO_PRIVATE_PATH')
  # Avoid filesystem-provider cmdlet initialization: Get-Item can stall on a
  # hosted Windows runner with this deliberately reduced child environment.
  $attributes = [IO.File]::GetAttributes($p)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
  $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $acl = if ($isDirectory) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  $protect = [Environment]::GetEnvironmentVariable('FLUJO_PRIVATE_ACTION') -eq 'protect'
  if ($owner.Value -ne $sid.Value) {
    # Elevated Windows processes can create files owned by their token's
    # default owner (Administrators). Normalize only that exact token owner
    # while protecting; existing private-file reads still require the user.
    if (-not $protect -or $owner.Value -ne $identity.Owner.Value) { throw 'unsafe' }
    $acl.SetOwner($sid)
  }
  if ($protect) {
    if ($isDirectory) {
      $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
      $inherit = [Security.AccessControl.InheritanceFlags]::None
    }
    # Modify the DACL and, only when needed above, its effective token owner.
    # Do not replace the full security descriptor or request its audit section.
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($oldRule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($oldRule) }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.SetAccessRule($rule)
    # The PowerShell provider's Set-Acl can request SeSecurityPrivilege when
    # reapplying a protected ACL. Persist only .NET's modified sections.
    if ($isDirectory) { [IO.Directory]::SetAccessControl($p, $acl) } else { [IO.File]::SetAccessControl($p, $acl) }
    $acl = if ($isDirectory) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }
  }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
  if (-not $acl.AreAccessRulesProtected) { throw 'unsafe' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { throw 'unsafe' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'unsafe' }
    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'unsafe' }
  }
  [Console]::Out.Write('private')
} catch { [Environment]::Exit(1) }
`;

async function windowsAcl(filename, protect) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await runFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(windowsAclScript, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 15_000, maxBuffer: 1024,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot,
        FLUJO_PRIVATE_PATH: filename, FLUJO_PRIVATE_ACTION: protect ? 'protect' : 'check' },
    });
    if (stdout !== 'private') throw unsafe();
  } catch { throw unsafe(); }
}

function plainDirectory(stat) { return stat.isDirectory() && !stat.isSymbolicLink(); }
function owned(stat) { return process.platform === 'win32' || stat.uid === process.getuid(); }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }

async function directoryTree(directory, create) {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  if (resolved === root) throw unsafe();
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (!plainDirectory(stat)) throw unsafe();
  }
  return resolved;
}

async function checkPrivate(filename, { directory = false, protect = false } = {}) {
  const before = await fs.lstat(filename);
  if (!owned(before) || before.isSymbolicLink()
    || (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1)) throw unsafe();
  if (process.platform === 'win32') await windowsAcl(filename, protect);
  else if (protect) await fs.chmod(filename, directory ? 0o700 : 0o600);
  const after = await fs.lstat(filename);
  if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()
    || !owned(after) || (process.platform !== 'win32' && (after.mode & 0o077) !== 0)) throw unsafe();
  return after;
}

export async function assertPrivateDirectory(directory) {
  const resolved = await directoryTree(directory, false);
  await checkPrivate(resolved, { directory: true });
  return resolved;
}

export async function ensurePrivateDirectory(directory) {
  try {
    const resolved = await directoryTree(directory, true);
    await checkPrivate(resolved, { directory: true, protect: true });
    return resolved;
  } catch { throw unsafe(); }
}

export async function readPrivateJson(filename, { maxBytes = 65536 } = {}) {
  let handle;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw unsafe();
    const resolved = path.resolve(filename);
    await assertPrivateDirectory(path.dirname(resolved));
    const before = await checkPrivate(resolved);
    if (before.size > maxBytes) throw unsafe();
    handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!sameFile(before, opened) || opened.nlink !== 1 || !opened.isFile()) throw unsafe();
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== before.size || !sameFile(before, await handle.stat())) throw unsafe();
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Private file was not found.'), { code: 'ENOENT' });
    throw unsafe();
  } finally { await handle?.close().catch(() => undefined); }
}

export async function writePrivateJson(filename, value, { exclusive = false } = {}) {
  const resolved = path.resolve(filename);
  let temporary;
  let handle;
  try {
    await ensurePrivateDirectory(path.dirname(resolved));
    try {
      await checkPrivate(resolved);
      if (exclusive) throw Object.assign(new Error('Private file already exists.'), { code: 'EEXIST' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
    handle = await fs.open(temporary, 'wx', 0o600);
    await checkPrivate(temporary, { protect: true });
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (exclusive) {
      // link() publishes the completed file atomically and refuses replacement.
      await fs.link(temporary, resolved);
      await fs.unlink(temporary);
    } else await fs.rename(temporary, resolved);
    temporary = undefined;
  } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Private file already exists.'), { code: 'EEXIST' });
    throw unsafe();
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
  }
}

export const LOCAL_INSTANCE_FORMAT = 'flujo-local-instance';
const instanceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenPattern = /^[A-Za-z0-9._~+/=-]{32,}$/;

export function localInstanceDirectory(env = process.env) {
  return path.resolve(env.FLUJO_LOCAL_INSTANCE_DIR || path.join(os.homedir(), '.flujo', 'instances'));
}

function argument(args, long, short) {
  const index = args.findIndex((arg) => arg === long || arg === short);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${long}=`))?.slice(long.length + 1);
}

/** Use the same numeric loopback address for Next's bind and its advertised proof. */
export function withLocalInstanceHostname(args, env) {
  const normalized = [...args];
  if (env.FLUJO_WORKER_MODE === '1' || env.FLUJO_CONTAINER || env.FLUJO_EXPOSURE_MODE !== 'localhost') return normalized;
  for (let index = 0; index < normalized.length; index += 1) {
    if ((normalized[index] === '--hostname' || normalized[index] === '-H') && normalized[index + 1] === 'localhost') {
      normalized[index + 1] = '127.0.0.1';
    } else if (normalized[index] === '--hostname=localhost') normalized[index] = '--hostname=127.0.0.1';
  }
  return normalized;
}

function nativeOrigin(env, args) {
  if (env.FLUJO_WORKER_MODE === '1' || env.FLUJO_CONTAINER || env.FLUJO_EXPOSURE_MODE !== 'localhost') return null;
  const hostname = argument(args, '--hostname', '-H') || '127.0.0.1';
  if (!['127.0.0.1', '::1', '[::1]'].includes(hostname)) return null;
  const port = Number(argument(args, '--port', '-p') || env.FLUJO_PORT || '4200');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local FLUJO instance port.');
  return `http://${hostname.includes(':') ? '[::1]' : '127.0.0.1'}:${port}`;
}

/**
 * Native launchers publish only after permissions are private and the child exists.
 * @param {{ env?: Record<string, string | undefined>, args?: string[], appRoot?: string }} options
 */
export async function prepareLocalInstance({ env = process.env, args = [], appRoot = process.cwd() } = {}) {
  const childEnv = { ...env };
  delete childEnv.FLUJO_LOCAL_INSTANCE_ID;
  delete childEnv.FLUJO_LOCAL_INSTANCE_ORIGIN;
  const origin = nativeOrigin(childEnv, args);
  if (!origin) return { env: childEnv, register: async () => undefined, cleanup: () => undefined };
  const token = childEnv.FLUJO_SNAPSHOT_CONTROL_TOKEN?.trim() || randomBytes(32).toString('base64url');
  if (!tokenPattern.test(token)) throw new Error('Local cloud control token must contain at least 32 URL-safe ASCII characters.');
  const dataRoot = path.resolve(childEnv.FLUJO_PARENT_DATA_DIR?.trim() || childEnv.FLUJO_DATA_DIR?.trim() || appRoot);
  const requestedDirectory = localInstanceDirectory(childEnv);
  const workspaceRelative = path.relative(path.join(dataRoot, 'workspaces'), requestedDirectory);
  if (workspaceRelative === '' || (!workspaceRelative.startsWith('..') && !path.isAbsolute(workspaceRelative))) {
    throw new Error('Local instance discovery must remain outside workspace snapshots.');
  }
  const directory = await ensurePrivateDirectory(requestedDirectory);
  const instanceId = randomUUID();
  childEnv.FLUJO_LOCAL_INSTANCE_ID = instanceId;
  childEnv.FLUJO_LOCAL_INSTANCE_ORIGIN = origin;
  childEnv.FLUJO_SNAPSHOT_CONTROL_TOKEN = token;
  const filename = path.join(directory, `${instanceId}.json`);
  let identity;
  let closed = false;
  const cleanup = () => {
    closed = true;
    if (!identity) return;
    try {
      const current = lstatSync(filename);
      if (current.dev === identity.dev && current.ino === identity.ino && current.isFile()
        && !current.isSymbolicLink() && current.nlink === 1) unlinkSync(filename);
    } catch { /* stale records are harmless: discovery requires a fresh proof */ }
  };
  return {
    env: childEnv,
    async register(pid) {
      if (closed) return;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Local FLUJO child did not start.');
      await writePrivateJson(filename, {
        format: LOCAL_INSTANCE_FORMAT, version: 1, instanceId, pid,
        origin, appRoot: path.resolve(appRoot), dataRoot, token,
      }, { exclusive: true });
      identity = await fs.lstat(filename);
      if (closed) cleanup();
    },
    cleanup,
  };
}

/**
 * Public challenge response, authenticated with a proof rather than a disclosed bearer.
 * @param {string} nonce
 * @param {Record<string, string | undefined>} env
 */
export function createLocalInstanceProof(nonce, env = process.env) {
  const instanceId = env.FLUJO_LOCAL_INSTANCE_ID;
  const origin = env.FLUJO_LOCAL_INSTANCE_ORIGIN;
  const token = env.FLUJO_SNAPSHOT_CONTROL_TOKEN?.trim();
  if (env.FLUJO_WORKER_MODE === '1' || env.FLUJO_CONTAINER || !instanceIdPattern.test(instanceId || '')
    || !/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(origin || '') || !tokenPattern.test(token || '')) return null;
  if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error('Invalid instance challenge.');
  const proof = createHmac('sha256', token).update(`flujo-local-instance:v1\n${nonce}\n${instanceId}\n${origin}`).digest('base64url');
  return { format: 'flujo-local-instance-proof', version: 1, instanceId, origin, nonce, proof };
}
