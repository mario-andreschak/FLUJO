import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '../../../utils/paths';
import { getExposureMode } from '../../../utils/http/exposureMode';
import { authenticateOwnerBearer, issueOwnerCredential, type OwnerPolicy } from './ownerCredentials';
import { readOwnerPolicy, ownerPolicyRevision } from './ownerPolicy';
import { createOwnerSession, ownerBrowserRequestAllowed } from './ownerSession';

const MAX_PAIRING_AGE = 15 * 60 * 1000;
function configuration() {
  if (process.env.FLUJO_WORKER_MODE === '1' || getExposureMode() !== 'localhost') throw new Error();
  const policy = process.env.FLUJO_OWNER_AUTH_FILE?.trim();
  const bootstrap = process.env.FLUJO_OWNER_BOOTSTRAP_FILE?.trim();
  const origin = new URL(process.env.FLUJO_OWNER_BROWSER_ORIGIN ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== process.env.FLUJO_OWNER_BROWSER_ORIGIN
      || !policy || !bootstrap || !path.isAbsolute(policy) || !path.isAbsolute(bootstrap)
      || path.dirname(policy) !== path.dirname(bootstrap) || policy === bootstrap) throw new Error();
  const directory = path.dirname(policy);
  const roots = [path.resolve(getDataDir())];
  try { roots.push(fs.realpathSync(roots[0])); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (roots.some(root => {
    const relative = path.relative(root, directory);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  })) throw new Error();
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
      || (process.platform !== 'win32' && ((stat.mode & BigInt(0o077)) !== BigInt(0)
        || stat.uid !== BigInt(process.getuid?.() ?? -1)))) throw new Error();
  try { fs.lstatSync(policy); throw new Error('Owner already enrolled'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { policy, bootstrap, directory, stat };
}
function grant(now: number) {
  const configured = configuration();
  const policy = readOwnerPolicy(configured.bootstrap);
  const [credential] = policy.credentials;
  if (!Number.isSafeInteger(now) || now < 0 || policy.credentials.length !== 1 || !credential
      || credential.revokedAt !== null || credential.issuedAt > now || credential.expiresAt <= now
      || credential.expiresAt - credential.issuedAt > MAX_PAIRING_AGE
      || credential.workspaceId !== undefined || credential.scopes.length !== 2
      || !['control:admin', 'secrets:read'].every(scope => credential.scopes.includes(scope as 'control:admin' | 'secrets:read'))) throw new Error();
  return { ...configured, grant: policy };
}
export function isOwnerBootstrapAvailable(now = Date.now()): boolean {
  try { grant(now); return true; } catch { return false; }
}
export function isOwnerBootstrapRequest(request: Request): boolean {
  try {
    return new URL(request.url).pathname === '/api/owner/bootstrap'
      && ['GET', 'POST'].includes(request.method) && ownerBrowserRequestAllowed(request, request.method === 'POST')
      && isOwnerBootstrapAvailable();
  } catch { return false; }
}
/** Capability proves control of the private local bootstrap file; Host is never authority. */
export function pairFirstOwner(request: Request, confirmed: boolean, now = Date.now()) {
  if (!confirmed || !ownerBrowserRequestAllowed(request, true)) throw new Error();
  const configured = grant(now);
  const principal = authenticateOwnerBearer(request, configured.grant, now);
  if (!principal) throw new Error();
  const issued = issueOwnerCredential(['control:admin', 'secrets:read'], now + 365 * 24 * 60 * 60 * 1000, now);
  const policy: OwnerPolicy = { schemaVersion: 1, ownerId: principal.ownerId, credentials: [issued.record] };
  const staged = path.join(configured.directory, `.owner-enrollment-${randomUUID()}`);
  const fd = fs.openSync(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(staged, { bigint: true });
    if (!opened.isFile() || opened.nlink !== BigInt(1) || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error();
    fs.writeFileSync(fd, JSON.stringify(policy)); fs.fsyncSync(fd);
    const current = fs.lstatSync(configured.directory, { bigint: true });
    if (current.dev !== configured.stat.dev || current.ino !== configured.stat.ino
        || current.mode !== configured.stat.mode || current.uid !== configured.stat.uid || current.gid !== configured.stat.gid
        || fs.realpathSync(configured.directory) !== configured.directory
        || ownerPolicyRevision(readOwnerPolicy(configured.bootstrap)) !== ownerPolicyRevision(configured.grant)
        || ownerPolicyRevision(readOwnerPolicy(staged)) !== ownerPolicyRevision(policy)
        || !isOwnerBootstrapAvailable(Math.max(now, Date.now()))) throw new Error();
    // No replacement: only one OS process can enroll the first owner.
    fs.linkSync(staged, configured.policy);
  } finally { fs.closeSync(fd); fs.unlinkSync(staged); }
  const committed = readOwnerPolicy(configured.policy);
  if (ownerPolicyRevision(committed) !== ownerPolicyRevision(policy)) throw new Error();
  let cookie: string | undefined;
  try {
    cookie = createOwnerSession(request, { ownerId: policy.ownerId, credentialId: issued.record.id,
      scopes: issued.record.scopes, expiresAt: issued.record.expiresAt, policyRevision: ownerPolicyRevision(policy) }, now);
  } catch { /* Enrollment remains committed; the one-time returned owner token can sign in. */ }
  return { token: issued.token, cookie };
}
