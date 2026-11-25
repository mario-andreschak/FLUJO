import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { type OwnerPolicy, type OwnerPrincipal } from './ownerCredentials';
import { ownerPolicyRevision, readOwnerPolicy } from './ownerPolicy';
import type { AuthenticatedOwnerPrincipal } from './ownerAccess';

const MAX_SESSION_BYTES = 4096;
export const OWNER_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const tokenPattern = /^flo_s1_[A-Za-z0-9_-]{43}$/;
const sessionSchema = z.object({
  schemaVersion: z.literal(1), ownerId: z.string(), credentialId: z.string(),
  policyRevision: z.string().regex(/^[a-f0-9]{64}$/), origin: z.string(),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
}).strict();
type Session = z.infer<typeof sessionSchema>;
function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink']
    .every(field => first[field as keyof BigIntStats] === second[field as keyof BigIntStats]);
}
export interface OwnerSessionPrincipal {
  readonly principal: OwnerPrincipal;
  readonly expiresAt: number;
  recheck(policy: OwnerPolicy, now: number): Promise<boolean>;
}

function browserOrigin(): URL {
  const configured = process.env.FLUJO_OWNER_BROWSER_ORIGIN;
  if (!configured) throw new Error('Owner browser origin is unavailable');
  const url = new URL(configured);
  if (url.origin !== configured || url.username || url.password
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url)))) {
    throw new Error('Owner browser origin is invalid');
  }
  return url;
}

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function cookieName(origin: URL): string {
  return origin.protocol === 'https:' ? '__Host-flujo-owner' : 'flujo-owner-local';
}

/** Never infer the browser authority from forwarded headers or a supplied Host. */
export function ownerBrowserRequestAllowed(request: Request, mutation = false): boolean {
  try {
    const origin = browserOrigin();
    const url = new URL(request.url);
    if (url.origin !== origin.origin || request.headers.get('host') !== origin.host) return false;
    const claimedOrigin = request.headers.get('origin');
    if (claimedOrigin !== null) return claimedOrigin === origin.origin;
    return !mutation && ['GET', 'HEAD'].includes(request.method)
      && request.headers.get('sec-fetch-site') === 'same-origin';
  } catch { return false; }
}

function cookie(request: Request, origin: URL): string | null {
  const name = cookieName(origin);
  const values = (request.headers.get('cookie') ?? '').split(';')
    .map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return tokenPattern.test(value) ? value : null;
}

async function privateDirectory(filename: string, create = false): Promise<string> {
  if (!path.isAbsolute(filename)) throw new Error('Invalid owner policy path');
  const directory = `${filename}.sessions`;
  if (create) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error('Unsafe owner session directory');
  }
  return directory;
}

async function sessionPath(filename: string, token: string, create = false): Promise<string> {
  return path.join(await privateDirectory(filename, create), `${createHash('sha256').update(token).digest('hex')}.json`);
}

async function readSession(file: string): Promise<Session | null> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || !named.isFile() || named.isSymbolicLink() || stat.nlink !== BigInt(1)
        || stat.size > BigInt(MAX_SESSION_BYTES) || !sameFile(stat, named)
        || (process.platform !== 'win32' && ((stat.mode & BigInt(0o077)) !== BigInt(0)
          || stat.uid !== BigInt(process.getuid?.() ?? -1)))) {
      throw new Error('Unsafe owner session record');
    }
    const bytes = Buffer.alloc(MAX_SESSION_BYTES + 1);
    const { bytesRead: length } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat({ bigint: true });
    const finalNamed = await fs.lstat(file, { bigint: true });
    if (BigInt(length) !== stat.size || !sameFile(stat, after)
        || finalNamed.isSymbolicLink() || !sameFile(stat, finalNamed)) throw new Error('Owner session record changed');
    return sessionSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally { await handle.close(); }
}

function active(session: Session, policy: OwnerPolicy, now: number): boolean {
  const credential = policy.credentials.find(value => value.id === session.credentialId);
  return Number.isSafeInteger(now) && now >= session.issuedAt && now < session.expiresAt
    && session.ownerId === policy.ownerId && session.policyRevision === ownerPolicyRevision(policy)
    && session.origin === browserOrigin().origin && Boolean(credential && credential.revokedAt === null
      && credential.issuedAt <= now && credential.expiresAt > now);
}

/** Durable server-issued IDs survive restart; no bearer or plaintext cookie is stored. */
export async function resolveOwnerSession(request: Request, policy: OwnerPolicy, filename: string,
  now: number): Promise<OwnerSessionPrincipal | null> {
  if (!process.env.FLUJO_OWNER_BROWSER_ORIGIN || !ownerBrowserRequestAllowed(request,
    !['GET', 'HEAD'].includes(request.method))) return null;
  const token = cookie(request, browserOrigin());
  if (!token) return null;
  const file = await sessionPath(filename, token);
  const session = await readSession(file);
  if (!session || !active(session, policy, now)) return null;
  const credential = policy.credentials.find(value => value.id === session.credentialId)!;
  return Object.freeze({
    principal: Object.freeze({ ownerId: policy.ownerId, credentialId: credential.id,
      scopes: Object.freeze([...credential.scopes]) }),
    expiresAt: session.expiresAt,
    recheck: async (current: OwnerPolicy, at: number) => {
      const saved = await readSession(file);
      return Boolean(saved && active(saved, current, at)
        && JSON.stringify(saved) === JSON.stringify(session));
    },
  });
}

/** Only an authenticated admin bearer may exchange itself for a browser session. */
export async function createOwnerSession(request: Request, principal: AuthenticatedOwnerPrincipal, now = Date.now()): Promise<string> {
  if (!ownerBrowserRequestAllowed(request, true)) throw new Error('Invalid owner browser request');
  const origin = browserOrigin();
  const filename = process.env.FLUJO_OWNER_AUTH_FILE?.trim();
  if (!filename || !Number.isSafeInteger(now)) throw new Error('Owner authentication is unavailable');
  const policy = await readOwnerPolicy(filename);
  const credential = policy.credentials.find(value => value.id === principal.credentialId);
  if (policy.ownerId !== principal.ownerId || ownerPolicyRevision(policy) !== principal.policyRevision
      || !credential || credential.revokedAt !== null
      || credential.issuedAt > now || credential.expiresAt <= now
      || !['control:admin', 'secrets:read'].every(scope => credential.scopes.includes(scope as 'control:admin' | 'secrets:read'))) {
    throw new Error('Owner authorization was lost');
  }
  const token = `flo_s1_${randomBytes(32).toString('base64url')}`;
  const expiresAt = Math.min(credential.expiresAt, now + OWNER_SESSION_MAX_AGE_MS);
  const record = sessionSchema.parse({ schemaVersion: 1, ownerId: policy.ownerId, credentialId: credential.id,
    policyRevision: ownerPolicyRevision(policy), origin: origin.origin, issuedAt: now, expiresAt });
  const handle = await fs.open(await sessionPath(filename, token, true), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
  finally { await handle.close(); }
  return `${cookieName(origin)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((expiresAt - now) / 1000)}${origin.protocol === 'https:' ? '; Secure' : ''}`;
}

export async function revokeOwnerSession(request: Request): Promise<string> {
  if (!ownerBrowserRequestAllowed(request, true)) throw new Error('Invalid owner browser request');
  const origin = browserOrigin();
  const filename = process.env.FLUJO_OWNER_AUTH_FILE?.trim();
  const token = cookie(request, origin);
  if (token && filename) {
    const file = await sessionPath(filename, token);
    if (await readSession(file)) await fs.unlink(file);
  }
  return `${cookieName(origin)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${origin.protocol === 'https:' ? '; Secure' : ''}`;
}
