import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Local tool for named access. Control of this machine's files is the authority,
 * as with owner-bootstrap: nothing here is reachable over HTTP.
 *
 *   enable <new-private-dir> [--owner id] [--origin http://localhost:4200]
 *       Creates a policy with one administrator. Prints the settings to use.
 *   recover <policy-file>
 *       Adds a fresh administrator. A corrupt policy is kept aside, not deleted.
 *   restore <policy-file>
 *       Puts back the last good policy kept beside the current one.
 *   export-v1 <policy-file> <new-file>
 *       Writes a policy an older FLUJO can read, for going back to an older version.
 *
 * The plain secret goes into a new private file named in the output. It is never
 * printed, so it cannot end up in a terminal history or a provisioning log.
 */

const ADMIN_SCOPES = ['control:admin', 'secrets:read', 'mcp:access', 'openai:read', 'openai:execute',
  'session:login', 'access:manage', 'audit:read'];
const LEGACY_SCOPES = new Set(['openai:read', 'openai:execute', 'mcp:access', 'control:admin', 'secrets:read', 'avatar:voice']);
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_CREDENTIALS = 128;
const LOCK_STALE_MS = 30_000;

function issueAdmin(name, now) {
  const token = `flo_v1_${randomBytes(32).toString('base64url')}`;
  return { token, record: {
    id: randomBytes(16).toString('hex'), digest: createHash('sha256').update(token).digest('hex'),
    scopes: [...ADMIN_SCOPES], issuedAt: now, expiresAt: now + ONE_YEAR_MS, revokedAt: null, name, role: 'admin',
  } };
}

function writePrivateExclusive(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function replacePolicy(filename, policy) {
  const staged = path.join(path.dirname(filename), `.owner-policy-${randomUUID()}`);
  writePrivateExclusive(staged, JSON.stringify(policy));
  try { fs.renameSync(staged, filename); }
  catch (error) { try { fs.unlinkSync(staged); } catch { /* Nothing more to do. */ } throw error; }
}

function withLock(filename, run) {
  const lock = `${filename}.lock`;
  try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock); } catch { /* No lock. */ }
  fs.closeSync(fs.openSync(lock, 'wx', 0o600));
  try { return run(); } finally { try { fs.unlinkSync(lock); } catch { /* Already gone. */ } }
}

function appendRecord(filename, action, now) {
  const line = `${JSON.stringify({ at: now, action, outcome: 'ok', detail: 'local tool' })}\n`;
  try { fs.appendFileSync(`${filename}.audit.jsonl`, line, { mode: 0o600 }); } catch { /* The record never blocks recovery. */ }
}

function assertOutsideData(directory) {
  const dataRoot = path.resolve(process.env.FLUJO_PARENT_DATA_DIR?.trim() || process.env.FLUJO_DATA_DIR?.trim() || process.cwd());
  const relative = path.relative(dataRoot, directory);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('The private directory must be outside the data directory.');
  }
}

export function enableAccess(directory, options = {}, now = Date.now()) {
  if (!path.isAbsolute(directory)) throw new Error('The private directory must be an absolute path.');
  const ownerId = options.owner ?? 'owner';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ownerId)) throw new Error('The owner id may hold letters, digits, - and _.');
  const resolved = path.resolve(directory);
  assertOutsideData(resolved);
  fs.mkdirSync(resolved, { mode: 0o700 }); // Never reuse or overwrite an existing authority directory.
  const policyFile = path.join(resolved, 'owner.json');
  const tokenFile = path.join(resolved, 'first-admin-token');
  const { token, record } = issueAdmin('Owner', now);
  writePrivateExclusive(tokenFile, token);
  writePrivateExclusive(policyFile, JSON.stringify({ schemaVersion: 2, ownerId, credentials: [record] }));
  appendRecord(policyFile, 'access.enable', now);
  return { policyFile, tokenFile, settings: {
    FLUJO_OWNER_AUTH_FILE: policyFile,
    FLUJO_OWNER_BROWSER_ORIGIN: options.origin ?? 'http://localhost:4200',
  } };
}

/** Reads the file without trusting it. Anything unusable counts as corrupt. */
function readLoosely(filename) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (parsed && typeof parsed.ownerId === 'string' && Array.isArray(parsed.credentials)
      && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2)) return parsed;
  } catch { /* Handled by the caller. */ }
  return null;
}

export function recoverAccess(filename, now = Date.now()) {
  if (!path.isAbsolute(filename)) throw new Error('The policy file must be an absolute path.');
  return withLock(filename, () => {
    const existing = fs.existsSync(filename) ? readLoosely(filename) : null;
    let setAside;
    if (fs.existsSync(filename) && !existing) {
      setAside = `${filename}.corrupt-${now}`;
      fs.renameSync(filename, setAside); // Keep it. It may be the only copy of something.
    }
    const { token, record } = issueAdmin('Recovery administrator', now);
    const ended = existing?.credentials ?? [];
    const kept = ended.length < MAX_CREDENTIALS ? ended
      : ended.filter(item => item.revokedAt === null && item.expiresAt > now).slice(-(MAX_CREDENTIALS - 1));
    let policy;
    if (existing?.schemaVersion === 1) {
      // A schema 1 file has no people yet. Add an owner it can read and leave it schema 1.
      const { name: _name, role: _role, ...legacy } = record;
      legacy.scopes = legacy.scopes.filter(scope => LEGACY_SCOPES.has(scope));
      policy = { schemaVersion: 1, ownerId: existing.ownerId, credentials: [...kept, legacy] };
    } else {
      policy = { schemaVersion: 2, ownerId: existing?.ownerId ?? 'owner', credentials: [...kept, record] };
    }
    const tokenFile = `${filename}.recovery-token-${now}`;
    writePrivateExclusive(tokenFile, token);
    replacePolicy(filename, policy);
    appendRecord(filename, 'access.recover', now);
    return { policyFile: filename, tokenFile, ...(setAside ? { corruptPolicyKeptAt: setAside } : {}) };
  });
}

export function restoreAccess(filename, now = Date.now()) {
  if (!path.isAbsolute(filename)) throw new Error('The policy file must be an absolute path.');
  return withLock(filename, () => {
    const previous = `${filename}.previous`;
    const policy = readLoosely(previous);
    if (!policy) throw new Error('There is no usable earlier policy to restore.');
    if (fs.existsSync(filename)) fs.renameSync(filename, `${filename}.replaced-${now}`);
    replacePolicy(filename, policy);
    appendRecord(filename, 'access.recover', now);
    return { policyFile: filename, restoredFrom: previous };
  });
}

/** Older versions read schema 1 only. People with narrow scopes are left out, not widened. */
export function exportLegacyPolicy(filename, target) {
  if (!path.isAbsolute(filename) || !path.isAbsolute(target)) throw new Error('Both paths must be absolute.');
  const policy = readLoosely(filename);
  if (!policy) throw new Error('The policy could not be read.');
  const credentials = [];
  for (const item of policy.credentials) {
    const scopes = item.scopes.filter(scope => LEGACY_SCOPES.has(scope));
    const usable = scopes.includes('control:admin') && scopes.includes('secrets:read')
      || (item.workspaceId === undefined && item.flowIds === undefined
        && item.scopes.every(scope => LEGACY_SCOPES.has(scope)));
    if (!usable) continue;
    credentials.push({ id: item.id, digest: item.digest, scopes, issuedAt: item.issuedAt,
      expiresAt: item.expiresAt, revokedAt: item.revokedAt });
  }
  writePrivateExclusive(target, JSON.stringify({ schemaVersion: 1, ownerId: policy.ownerId, credentials }));
  return { policyFile: target, kept: credentials.length, leftOut: policy.credentials.length - credentials.length };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, first, ...rest] = process.argv.slice(2);
  try {
    let result;
    if (command === 'enable' && first) {
      result = enableAccess(first, { owner: option(rest, '--owner'), origin: option(rest, '--origin') });
    } else if (command === 'recover' && first) result = recoverAccess(first);
    else if (command === 'restore' && first) result = restoreAccess(first);
    else if (command === 'export-v1' && first && rest[0]) result = exportLegacyPolicy(first, rest[0]);
    else throw new Error('Use: enable <new-private-dir> | recover <policy-file> | restore <policy-file> | export-v1 <policy-file> <new-file>');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'The access tool failed.'} Existing authority was preserved.\n`);
    process.exitCode = 1;
  }
}
