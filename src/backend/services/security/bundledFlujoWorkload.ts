import fs, { constants } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir, isValidWorkspaceName, runWithWorkspace } from '@/utils/workspace';
import { PlainFileReadError, readPlainFile } from '@/utils/readPlainFile';
import { retryTransientFileOperation } from '@/utils/transientFileRetry';
import { realpath } from '@/utils/realpath';
import { assertCredentialStoreReady } from '@/utils/encryption/credentialMigrationState';
import { ownerPolicySchema } from './ownerCredentials';
import { ownerPolicyRevision } from './ownerPolicy';
import { readPrivateApprovalAsync, readPrivateApprovalSetAsync, sameTrustedHostConsent, trustedHostEnvironment,
  trustedHostApprovalsSchema, trustedHostMcpApprovalAsync, trustedHostMcpPolicyDigestAsync, trustedHostMcpPolicySchema, verifyTrustedHostMcp } from './trustedHostMcp';
import { canonicalWorkloadJson, computeBundledFlujoWorkloadDefinitions, computeBundledFlujoWorkloadInventory,
  type WorkloadAction } from '../mcp/bundledFlujoWorkloadInventory';
import { stdioLaunchForm } from '../mcp/launchForm';

export const BUNDLED_FLUJO_WORKLOAD_TOKEN_ENV = 'FLUJO_MCP_WORKLOAD_TOKEN';
export const BUNDLED_FLUJO_WORKLOAD_AUDIENCE_ENV = 'FLUJO_MCP_WORKLOAD_AUDIENCE';
const tokenPattern = /^flo_mcp1_[A-Za-z0-9_-]{43}$/;
type GuardStage = 'private-set-initial' | 'config-first' | 'package-verification'
  | 'inventory' | 'config-latest' | 'config-final' | 'private-set-final' | 'digest-final'
  | 'activation-owner' | 'activation-grant' | 'activation-marker' | 'activation-record' | 'activation-owner-final' | 'activation-grant-final';
function traceAsync<T>(stage: GuardStage, operation: () => Promise<T>): Promise<T> {
  if (process.env.FLUJO_MCP_WORKLOAD_TRACE !== '1') return operation();
  const started = performance.now();
  console.info('[workload-guard]', stage, 'start');
  return operation().finally(() => console.info('[workload-guard]', stage, 'settled', Math.round(performance.now() - started)));
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const identityFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const;
const stamp = (stat: fs.BigIntStats) => Object.fromEntries(identityFields.map(name => [name, String(stat[name])])) as Record<typeof identityFields[number], string>;
const same = (left: fs.BigIntStats, right: fs.BigIntStats) => identityFields.every(name => left[name] === right[name]);
const identitySchema = z.object(Object.fromEntries(identityFields.map(name => [name, z.string().regex(/^\d{1,40}$/)])) as Record<typeof identityFields[number], z.ZodString>).strict();
const inventorySchema = trustedHostMcpPolicySchema.shape.bundledInstallation.unwrap().shape.workload.unwrap().shape.inventory;
const recordSchema = z.object({ version: z.literal(1), purpose: z.literal('bundled-flujo-control-v1'),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/), generation: z.string().uuid(), ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), ownerRevision: z.string().regex(/^[a-f0-9]{64}$/),
  workspace: z.string().refine(isValidWorkspaceName), serverName: z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)), audience: z.string().max(2048), policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), markerIdentity: identitySchema,
  markerDigest: z.string().regex(/^[a-f0-9]{64}$/), inventory: inventorySchema,
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt <= value.issuedAt + 5 * 60_000);
const markerSchema = z.object({ version: z.literal(1), generation: z.string().uuid(), state: z.literal('active'),
  recordDev: z.string().regex(/^\d{1,40}$/), recordIno: z.string().regex(/^\d{1,40}$/) }).strict();
interface OwnedFile { fd: number | undefined; filename: string; bytes: Buffer; identity: fs.BigIntStats;
  parentIdentity: fs.BigIntStats; removed?: boolean; uncertainDescriptor?: number; readOnlyWitness?: boolean;
  recoveryWriter?: { fd?: number; uncertainDescriptor?: number } }
declare const capsuleBrand: unique symbol;
export interface PendingBundledFlujoWorkload { readonly [capsuleBrand]: true }
interface Pending { config: MCPStdioConfig; token: string; audience: string; workspace: string; ledger: string;
  ownerFile: string; state: 'inactive' | 'activating' | 'active' | 'retired' | 'uncertain'; generation?: string;
  record?: OwnedFile; marker?: OwnedFile; durablyRevoked?: boolean;
  /** Activation and retirement take turns on the owned descriptors; neither runs inside the other. */
  files: Promise<void>; retiring?: Promise<void> }
const capsules = new WeakMap<object, Pending>();
const principals = new WeakSet<object>();
// Reuse only this graph's opaque request binding. Every action/effect still
// performs the full fresh durable recheck; no authority verdict is retained.
const foreignRequestPrincipals = new WeakMap<Request, BundledFlujoWorkloadAuthorization>();
const context = new AsyncLocalStorage<{ authorization: BundledFlujoWorkloadAuthorization; request: Request }>();
// Next server graphs share only the original request, never an authorization
// verdict. A receiving graph authenticates it into its own private principal.
const requestCarrierKey = Symbol.for('FLUJO:bundled-flujo-workload-request:v1');
const errorProvenanceKey = Symbol.for('FLUJO:bundled-flujo-workload-errors:v1');
function processObject<T>(key: symbol, create: () => T, accepts: (value: unknown) => value is T): T {
  const existing = Object.getOwnPropertyDescriptor(globalThis, key);
  if (existing) {
    if (!('value' in existing) || existing.configurable || existing.writable || !accepts(existing.value)) throw new Error('Workload process context refused.');
    return existing.value;
  }
  const value = create();
  Object.defineProperty(globalThis, key, { value, writable: false, configurable: false, enumerable: false });
  return value;
}
const requestCarrier = processObject(requestCarrierKey, () => new AsyncLocalStorage<Request>(),
  (value): value is AsyncLocalStorage<Request> => value instanceof AsyncLocalStorage);
const errorProvenance = processObject(errorProvenanceKey, () => new WeakSet<object>(),
  (value): value is WeakSet<object> => value instanceof WeakSet);
// A token stops working the moment its retirement is requested, in every
// server graph, while the durable revocation of its files finishes.
const revokingKey = Symbol.for('FLUJO:bundled-flujo-workload-revoking:v1');
const revoking = processObject(revokingKey, () => new Set<string>(),
  (value): value is Set<string> => value instanceof Set);
const isRevoking = (key: string) => Set.prototype.has.call(revoking, key);
function originalWorkloadRequest(): Request | undefined {
  const value: unknown = AsyncLocalStorage.prototype.getStore.call(requestCarrier);
  if (value !== undefined && !(value instanceof Request)) throw new BundledFlujoWorkloadError();
  return value;
}
const denied = () => Response.json({ error: 'Bundled workload authorization refused.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
export class BundledFlujoWorkloadError extends Error {
  readonly response = denied();
  constructor(cause?: unknown) {
    super('Bundled workload authorization refused.', { cause });
    WeakSet.prototype.add.call(errorProvenance, this);
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return !!value && typeof value === 'object' && WeakSet.prototype.has.call(errorProvenance, value);
  }
}
function audience(value: string | undefined): string {
  if (!value) throw new BundledFlujoWorkloadError();
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new BundledFlujoWorkloadError();
  return url.origin;
}
function directory(ledger: string): string {
  if (!path.isAbsolute(ledger)) throw new BundledFlujoWorkloadError();
  return path.join(path.dirname(ledger), `.flujo-workloads-${hash(path.resolve(ledger)).slice(0, 24)}`);
}
function capsule(value: PendingBundledFlujoWorkload): Pending {
  const pending = capsules.get(value); if (!pending) throw new BundledFlujoWorkloadError(); return pending;
}
function assertPending(pending: Pending) {
  if (pending.state === 'retired' || pending.state === 'uncertain' || pending.ledger !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE
      || pending.ownerFile !== process.env.FLUJO_OWNER_AUTH_FILE || getCurrentWorkspace() !== pending.workspace
      || audience(process.env.FLUJO_BASE_URL) !== pending.audience) throw new BundledFlujoWorkloadError();
}
export function prepareBundledFlujoWorkload(config: MCPStdioConfig): PendingBundledFlujoWorkload | undefined {
  const env = trustedHostEnvironment(config);
  if ([...env.keys()].some(name => [BUNDLED_FLUJO_WORKLOAD_TOKEN_ENV, BUNDLED_FLUJO_WORKLOAD_AUDIENCE_ENV].includes(name.toUpperCase()))) throw new BundledFlujoWorkloadError();
  if (process.env.FLUJO_WORKER_MODE === '1' || config.trustedHost === undefined) return undefined;
  const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
  if (policy.bundledInstallation?.packageDirectory !== 'flujo') return undefined;
  if (!policy.bundledInstallation?.workload || ![BUNDLED_FLUJO_WORKLOAD_TOKEN_ENV, BUNDLED_FLUJO_WORKLOAD_AUDIENCE_ENV].every(name => policy.environmentNames.includes(name))) throw new BundledFlujoWorkloadError();
  const selected = getCurrentWorkspace(), target = audience(process.env.FLUJO_BASE_URL);
  if (audience(env.get('FLUJO_BASE_URL')) !== target || env.get('FLUJO_WORKSPACE') !== selected) throw new BundledFlujoWorkloadError();
  const ledger = process.env.FLUJO_MCP_TRUSTED_HOST_FILE, ownerFile = process.env.FLUJO_OWNER_AUTH_FILE;
  if (!ledger || !ownerFile) throw new BundledFlujoWorkloadError();
  const value = Object.freeze({}) as PendingBundledFlujoWorkload;
  capsules.set(value, { config: structuredClone(config), token: `flo_mcp1_${randomBytes(32).toString('base64url')}`,
    audience: target, workspace: selected, ledger, ownerFile, state: 'inactive', files: Promise.resolve() });
  return value;
}
export function getPendingWorkloadEnvironment(config: MCPStdioConfig, value: PendingBundledFlujoWorkload | undefined): Readonly<Record<string, string>> {
  if (!value) return Object.freeze({});
  const pending = capsule(value); assertPending(pending);
  if (!sameTrustedHostConsent(config, pending.config)) throw new BundledFlujoWorkloadError();
  return Object.freeze({ [BUNDLED_FLUJO_WORKLOAD_TOKEN_ENV]: pending.token, [BUNDLED_FLUJO_WORKLOAD_AUDIENCE_ENV]: pending.audience });
}
/**
 * Descriptor calls keep raw descriptor numbers: an ambiguous close is settled
 * only by an authoritative EBADF for that exact number, never by a handle.
 */
function descriptorCall<T>(start: (done: (error: NodeJS.ErrnoException | null, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => { start((error, value) => error ? reject(error) : resolve(value as T)); });
}
const openDescriptor = (filename: string, flags: number, mode?: number) =>
  descriptorCall<number>(done => fs.open(filename, flags, mode, done));
const describeDescriptor = (fd: number) => descriptorCall<fs.BigIntStats>(done => fs.fstat(fd, { bigint: true }, done));
const probeDescriptor = (fd: number) => descriptorCall<fs.Stats>(done => fs.fstat(fd, done));
const readDescriptor = (fd: number, bytes: Buffer, position: number) =>
  descriptorCall<number>(done => fs.read(fd, bytes, 0, bytes.length, position, done));
const writeDescriptor = (fd: number, bytes: Buffer, offset: number) =>
  descriptorCall<number>(done => fs.write(fd, bytes, offset, bytes.length - offset, offset, done));
const truncateDescriptor = (fd: number, length: number) => descriptorCall<void>(done => fs.ftruncate(fd, length, done));
const syncDescriptor = (fd: number) => descriptorCall<void>(done => fs.fsync(fd, done));
const closeDescriptor = (fd: number) => descriptorCall<void>(done => fs.close(fd, done));
const lstatExact = (filename: string) => fs.promises.lstat(filename, { bigint: true });
/** Every owned file step waits for the step before it on the same capsule. */
function exclusive<T>(pending: Pending, operation: () => Promise<T>): Promise<T> {
  const run = pending.files.then(operation);
  pending.files = run.then(() => undefined, () => undefined);
  return run;
}
async function writeAll(fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) { const count = await writeDescriptor(fd, bytes, offset); if (!count) throw new BundledFlujoWorkloadError(); offset += count; }
  await truncateDescriptor(fd, bytes.length); await syncDescriptor(fd);
}
function descriptor(file: OwnedFile): number {
  if (file.fd === undefined || file.uncertainDescriptor !== undefined) throw new BundledFlujoWorkloadError();
  return file.fd;
}
async function assertOwnedParent(file: OwnedFile) {
  const parent = path.dirname(file.filename), current = await lstatExact(parent);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== file.parentIdentity.dev
      || current.ino !== file.parentIdentity.ino || current.mode !== file.parentIdentity.mode
      || current.uid !== file.parentIdentity.uid || current.gid !== file.parentIdentity.gid
      || path.relative(await realpath(parent), parent) !== '') throw new BundledFlujoWorkloadError();
}
async function readExact(file: OwnedFile) {
  const fd = descriptor(file), before = await describeDescriptor(fd);
  if (!same(before, file.identity) || !before.isFile() || before.nlink !== BigInt(file.removed ? 0 : 1)) throw new BundledFlujoWorkloadError();
  if (!same(before, await lstatExact(file.filename))) throw new BundledFlujoWorkloadError();
  const bytes = Buffer.alloc(file.bytes.length + 1);
  try {
    const count = await readDescriptor(fd, bytes, 0);
    if (count !== file.bytes.length || !bytes.subarray(0, count).equals(file.bytes) || !same(before, await describeDescriptor(fd))
        || !same(before, await lstatExact(file.filename))) throw new BundledFlujoWorkloadError();
  } finally { bytes.fill(0); }
}
async function createFile(filename: string): Promise<OwnedFile> {
  const parentIdentity = await lstatExact(path.dirname(filename));
  const fd = await openDescriptor(filename, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
  return { fd, filename, bytes: Buffer.alloc(0), identity: await describeDescriptor(fd), parentIdentity };
}
async function fillFile(file: OwnedFile, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 64 * 1024) throw new BundledFlujoWorkloadError();
  await readExact(file); await writeAll(descriptor(file), bytes); file.bytes.fill(0); file.bytes = bytes; file.identity = await describeDescriptor(descriptor(file));
  await readExact(file); await readPrivateApprovalAsync(file.filename);
}
/** Activation accepts only the private start proof minted by the genuine host guard. */
export async function activatePendingWorkload(value: PendingBundledFlujoWorkload, proof: unknown): Promise<void> {
  const pending = capsule(value);
  if (pending.state !== 'inactive') throw new BundledFlujoWorkloadError();
  pending.state = 'activating';
  try {
    const { assertVerifiedBundledFlujoWorkloadStart } = await import('../mcp/trustedHost');
    assertPending(pending);
    const verified = assertVerifiedBundledFlujoWorkloadStart(proof, value);
    verified.assertLive();
    pending.generation = verified.generation;
    if (!sameTrustedHostConsent(verified.config, pending.config)) throw new BundledFlujoWorkloadError();
    const inventory = await computeBundledFlujoWorkloadInventory(); assertPending(pending); verified.assertLive();
    if (canonicalWorkloadJson(inventory) !== canonicalWorkloadJson(trustedHostMcpPolicySchema.parse(pending.config.trustedHost).bundledInstallation?.workload?.inventory)) throw new BundledFlujoWorkloadError();
    const owner = ownerPolicySchema.parse(await traceAsync('activation-owner', () => readPrivateApprovalAsync(pending.ownerFile))); assertPending(pending); verified.assertLive();
    const authority = await traceAsync('activation-grant', () => trustedHostMcpApprovalAsync(pending.config));
    if (owner.ownerId !== authority.ownerId || authority.digest !== verified.digest || authority.ownerId !== verified.ownerId) throw new BundledFlujoWorkloadError();
    const parent = directory(pending.ledger);
    try { await fs.promises.mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const parentStat = await fs.promises.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || path.relative(await realpath(parent), parent) !== ''
        || (await fs.promises.readdir(parent)).length >= 512) throw new BundledFlujoWorkloadError();
    assertPending(pending); verified.assertLive();
    const key = hash(pending.token);
    // The authoritative name stays absent until every activation guard passes.
    const publishedName = path.join(parent, `${key}.json`);
    const record = await exclusive(pending, async () => {
      assertPending(pending); verified.assertLive();
      pending.record = await createFile(path.join(parent, `${key}.pending`));
      pending.marker = await createFile(path.join(parent, `${key}.lease`));
      await traceAsync('activation-marker', () => fillFile(pending.marker!, { version: 1, generation: verified.generation, state: 'active',
        recordDev: String(pending.record!.identity.dev), recordIno: String(pending.record!.identity.ino) }));
      const now = Date.now();
      const created = recordSchema.parse({ version: 1, purpose: 'bundled-flujo-control-v1', tokenHash: key, generation: verified.generation,
        ownerId: owner.ownerId, ownerRevision: ownerPolicyRevision(owner), workspace: pending.workspace, serverName: pending.config.name,
        audience: pending.audience, policyDigest: authority.digest, issuedAt: now, expiresAt: Math.min(now + 5 * 60_000, authority.expiresAt),
        markerIdentity: stamp(pending.marker.identity), markerDigest: hash(pending.marker.bytes), inventory });
      assertPending(pending); verified.assertLive();
      await traceAsync('activation-record', () => fillFile(pending.record!, created));
      return created;
    });
    if (ownerPolicyRevision(ownerPolicySchema.parse(await traceAsync('activation-owner-final', () => readPrivateApprovalAsync(pending.ownerFile)))) !== record.ownerRevision) throw new BundledFlujoWorkloadError();
    const final = await traceAsync('activation-grant-final', () => trustedHostMcpApprovalAsync(pending.config)); assertPending(pending); verified.assertLive();
    if (final.digest !== record.policyDigest || final.ownerId !== record.ownerId || record.expiresAt <= Date.now()) throw new BundledFlujoWorkloadError();
    await exclusive(pending, async () => {
      const marker = pending.marker!, published = pending.record!;
      await readExact(marker); await readExact(published);
      if (await pathExists(publishedName)) throw new BundledFlujoWorkloadError();
      assertPending(pending); verified.assertLive();
      // Exclusive publication cannot overwrite an unknown replacement.
      await fs.promises.link(published.filename, publishedName);
      const pendingName = await lstatExact(published.filename);
      const publishedIdentity = await lstatExact(publishedName);
      const linked = await describeDescriptor(descriptor(published));
      if (linked.nlink !== BigInt(2) || !same(linked, pendingName) || !same(linked, publishedIdentity)) throw new BundledFlujoWorkloadError();
      await fs.promises.unlink(published.filename);
      published.filename = publishedName;
      await syncDescriptor(descriptor(published));
      published.identity = await describeDescriptor(descriptor(published));
      await readExact(published);
      // A retirement requested while publishing wins over activation.
      assertPending(pending);
      pending.state = 'active';
    });
  } catch (cause) {
    try { await revokePendingWorkload(value); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Workload activation and durable retirement failed.', { cause }); }
    throw cause;
  }
}
async function pathExists(filename: string): Promise<boolean> {
  try { await fs.promises.lstat(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function settleDescriptor(file: { uncertainDescriptor?: number }) {
  if (file.uncertainDescriptor === undefined) return;
  // Metadata probing cannot close or mutate a descriptor that may have been
  // recycled. Only authoritative EBADF settles the uncertainty.
  try { await probeDescriptor(file.uncertainDescriptor); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EBADF') { file.uncertainDescriptor = undefined; return; }
    throw error;
  }
  throw new BundledFlujoWorkloadError();
}
async function settleAcquisition(file: OwnedFile) {
  if (!file.recoveryWriter) return;
  await settleDescriptor(file.recoveryWriter);
  if (file.recoveryWriter.fd !== undefined) throw new BundledFlujoWorkloadError();
  file.recoveryWriter = undefined;
}
async function closeOwnedFile(file: OwnedFile) {
  // Both retry and independent close refuse an unresolved acquisition before
  // allocating any replacement witness or overwriting its private evidence.
  await settleAcquisition(file);
  await settleDescriptor(file);
  if (file.fd === undefined) return;
  // Keep a genuine original-file witness across our own writable close. Windows
  // finalizes ctime on close; a later named reopen alone cannot prove that change.
  let witness: number | undefined;
  if (!file.removed) {
    await assertOwnedParent(file); await readExact(file);
    if (file.bytes.length) await readPrivateApprovalAsync(file.filename);
    witness = await openDescriptor(file.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const acquired = { fd: witness as number | undefined, uncertainDescriptor: undefined as number | undefined };
    file.recoveryWriter = acquired;
    try {
      if (!same(file.identity, await describeDescriptor(witness))) throw new BundledFlujoWorkloadError();
      await readExact(file); await assertOwnedParent(file);
    } catch (error) {
      // This freshly opened witness is owned independently of the writer.
      acquired.fd = undefined;
      try { await closeDescriptor(witness); } catch (cleanup) {
        acquired.uncertainDescriptor = witness;
        try { await settleDescriptor(acquired); } catch { /* Preserve ambiguous witness ownership. */ }
        throw new AggregateError([error, cleanup], 'Workload close witness failed.', { cause: error });
      }
      file.recoveryWriter = undefined;
      throw error;
    }
    file.recoveryWriter = undefined;
  }
  const before = file.identity;
  const fd = file.fd; file.fd = undefined;
  let closeError: unknown;
  try { await closeDescriptor(fd); }
  catch (error) {
    closeError = error;
    file.uncertainDescriptor = fd;
    try { await settleDescriptor(file); } catch { /* Retain uncertainty without touching a possibly recycled descriptor. */ }
  }
  if (witness !== undefined) {
    file.fd = witness; file.readOnlyWitness = true;
    try { if (file.uncertainDescriptor === undefined) {
      const after = await describeDescriptor(witness);
      // Only this exclusive, witnessed, owned close transition may finalize
      // ctime. Every other field and exact bytes must remain unchanged; subsequent
      // guards compare the entire refreshed identity, including ctime.
      if (!identityFields.filter(field => field !== 'ctimeNs').every(field => before[field] === after[field])) throw new BundledFlujoWorkloadError();
      const previous = file.identity; file.identity = after;
      try { await readExact(file); await assertOwnedParent(file); if (file.bytes.length) await readPrivateApprovalAsync(file.filename); await readExact(file); }
      catch (error) { file.identity = previous; throw error; }
    } } catch (error) {
      if (closeError !== undefined) throw new AggregateError([closeError, error], 'Workload close and witness verification failed.', { cause: closeError });
      throw error;
    }
  }
  if (closeError !== undefined) throw closeError;
}
async function recoverOwnedFile(file: OwnedFile) {
  await settleAcquisition(file);
  await settleDescriptor(file); await assertOwnedParent(file);
  if (file.removed) {
    try { await fs.promises.lstat(file.filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new BundledFlujoWorkloadError();
  }
  if (file.fd !== undefined) {
    await readExact(file);
    if (file.readOnlyWitness) {
      if (file.bytes.length) await readPrivateApprovalAsync(file.filename);
      const reader = file.fd;
      const writer = await openDescriptor(file.filename, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const acquired = { fd: writer as number | undefined, uncertainDescriptor: undefined as number | undefined };
      file.recoveryWriter = acquired;
      try {
        if (!same(file.identity, await describeDescriptor(writer))) throw new BundledFlujoWorkloadError();
        await readExact(file); await assertOwnedParent(file);
      } catch (error) {
        acquired.fd = undefined;
        try { await closeDescriptor(writer); }
        catch (cleanup) {
          acquired.uncertainDescriptor = writer;
          try { await settleDescriptor(acquired); } catch { /* Retain ambiguous writer ownership. */ }
          throw new AggregateError([error, cleanup], 'Workload retry writer verification and cleanup failed.', { cause: error });
        }
        file.recoveryWriter = undefined;
        throw error;
      }
      file.fd = writer; file.readOnlyWitness = false;
      file.recoveryWriter = undefined;
      try { await closeDescriptor(reader); }
      catch (error) { file.uncertainDescriptor = reader; try { await settleDescriptor(file); } catch { /* Preserve ambiguous reader ownership. */ } throw error; }
      await readExact(file); await assertOwnedParent(file);
    }
    return;
  }
  if (!same(file.identity, await lstatExact(file.filename))) throw new BundledFlujoWorkloadError();
  if (file.bytes.length) await readPrivateApprovalAsync(file.filename);
  file.fd = await openDescriptor(file.filename, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  await readExact(file); await assertOwnedParent(file);
}
/**
 * Completed durable invalidation, with private proof retained for safe retry.
 * The token is refused from the moment of the call. Callers that arrive while
 * an attempt runs share it; a call after a failed attempt starts a fresh one.
 */
export async function revokePendingWorkload(value: PendingBundledFlujoWorkload | undefined): Promise<void> {
  if (!value) return;
  const pending = capsule(value);
  if (pending.state === 'retired') return;
  pending.state = 'uncertain';
  Set.prototype.add.call(revoking, hash(pending.token));
  pending.retiring ??= exclusive(pending, () => retire(pending)).finally(() => { pending.retiring = undefined; });
  return pending.retiring;
}
async function retire(pending: Pending): Promise<void> {
  if (pending.state === 'retired') return;
  pending.state = 'uncertain';
  const errors: unknown[] = [];
  const marker = pending.marker;
  if (marker) try {
    await recoverOwnedFile(marker);
    if (!pending.durablyRevoked) {
      if (marker.removed) throw new BundledFlujoWorkloadError();
      if (marker.bytes.length) await readPrivateApprovalAsync(marker.filename);
      await readExact(marker);
      const revoked = Buffer.from(JSON.stringify({ version: 1, generation: pending.generation, state: 'revoked' }));
      await writeAll(descriptor(marker), revoked);
      marker.bytes.fill(0); marker.bytes = revoked;
      marker.identity = await describeDescriptor(descriptor(marker));
      await readExact(marker); await assertOwnedParent(marker);
      pending.durablyRevoked = true;
    }
  } catch (error) { errors.push(error); }
  for (const file of [pending.record, pending.marker]) if (file) {
    try {
      await recoverOwnedFile(file);
      if (!file.removed) {
        if (file.bytes.length) await readPrivateApprovalAsync(file.filename);
        await readExact(file); await assertOwnedParent(file);
        await fs.promises.unlink(file.filename);
        const removed = await describeDescriptor(descriptor(file));
        if (removed.dev !== file.identity.dev || removed.ino !== file.identity.ino || removed.nlink !== BigInt(0)
            || removed.mode !== file.identity.mode || removed.uid !== file.identity.uid || removed.gid !== file.identity.gid) throw new BundledFlujoWorkloadError();
        file.identity = removed; file.removed = true;
        await syncDescriptor(descriptor(file));
      }
    } catch (error) { errors.push(error); }
    try { await closeOwnedFile(file); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Workload retirement remains uncertain.');
  if (marker && !pending.durablyRevoked) throw new BundledFlujoWorkloadError();
  for (const file of [pending.record, pending.marker]) file?.bytes.fill(0);
  pending.state = 'retired';
  Set.prototype.delete.call(revoking, hash(pending.token));
}

export interface BundledFlujoWorkloadAuthorization {
  readonly workspace: string; readonly serverName: string; readonly generation: string; readonly inventory: readonly WorkloadAction[];
  readRequest(): Request;
  recheck(): Promise<Response | null>;
}
/**
 * A storage write replaces mcp_servers.json by renaming over it, so a read can
 * meet the old file at one look and the new file at the next. Only that read
 * starts again from scratch; every other refusal stands.
 */
function replacedWhileRead(error: unknown): boolean {
  return error instanceof PlainFileReadError && (error.code === 'FILE_CHANGED' || (error.code === 'UNSAFE_FILE'
    && (error.detail?.startsWith('expected:') === true || error.detail?.startsWith('descriptor-path:') === true)));
}
/** Never initialize, back up, migrate, normalize, or join a storage write chain. */
function readCurrentConfig(serverName: string, signal: AbortSignal) {
  return retryTransientFileOperation(() => readCurrentConfigOnce(serverName, signal), { label: 'workload-config', signal, isTransient: replacedWhileRead });
}
async function readCurrentConfigOnce(serverName: string, signal: AbortSignal) {
  const root = path.resolve(getWorkspaceDataDir());
  const filename = path.join(root, 'db', 'mcp_servers.json');
  const parents: Array<{ filename: string; identity: fs.BigIntStats }> = [];
  let current = path.dirname(filename);
  while (true) {
    const identity = await fs.promises.lstat(current, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink() || path.relative(await realpath(current), current) !== '') throw new BundledFlujoWorkloadError();
    parents.push({ filename: current, identity });
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  const assertParents = async () => {
    for (const parent of parents) {
      const fresh = await fs.promises.lstat(parent.filename, { bigint: true });
      // Directory size/timestamps legitimately change during the guarded write.
      if (!fresh.isDirectory() || fresh.isSymbolicLink() || fresh.dev !== parent.identity.dev || fresh.ino !== parent.identity.ino
          || fresh.mode !== parent.identity.mode || fresh.uid !== parent.identity.uid || fresh.gid !== parent.identity.gid
          || path.relative(await realpath(parent.filename), parent.filename) !== '') throw new BundledFlujoWorkloadError();
    }
  };
  const verifyPath = async () => {
    await assertParents();
    await assertCredentialStoreReady(filename);
  };
  await verifyPath();
  const identity = await fs.promises.lstat(filename, { bigint: true });
  const bytes = await readPlainFile(filename, { maxBytes: 4 * 1024 * 1024, signal, verifyPath, expected: identity });
  try {
    const stored: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !Object.hasOwn(stored, serverName)) throw new BundledFlujoWorkloadError();
    const selected: unknown = (stored as Record<string, unknown>)[serverName];
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new BundledFlujoWorkloadError();
    const config = { ...selected, name: serverName } as MCPStdioConfig;
    if (config.transport !== 'stdio' || config.disabled || typeof config.command !== 'string' || typeof config.cwd !== 'string') throw new BundledFlujoWorkloadError();
    trustedHostMcpPolicySchema.parse(config.trustedHost);
    return { config, assertCurrent: async () => {
      if (!same(identity, await fs.promises.lstat(filename, { bigint: true }))) throw new BundledFlujoWorkloadError();
      await assertParents();
      signal.throwIfAborted();
    } };
  } finally { bytes.fill(0); }
}
async function evidence(request: Request) {
  let phase: 'request' | 'private-files' | 'private-binding' | 'request-binding' | 'config' | 'package'
    | 'inventory-binding' | 'config-fences' | 'final-private-binding' | 'final-file-fences' = 'request';
  try {
  request.signal.throwIfAborted();
  const match = /^Bearer (flo_mcp1_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
  if (!match || !tokenPattern.test(match[1]) || process.env.FLUJO_WORKER_MODE === '1') throw new BundledFlujoWorkloadError();
  const ledger = process.env.FLUJO_MCP_TRUSTED_HOST_FILE, ownerFile = process.env.FLUJO_OWNER_AUTH_FILE;
  if (!ledger || !ownerFile) throw new BundledFlujoWorkloadError();
  const key = hash(match[1]), filename = path.join(directory(ledger), `${key}.json`), markerFilename = path.join(directory(ledger), `${key}.lease`);
  if (isRevoking(key)) throw new BundledFlujoWorkloadError();
  phase = 'private-files';
  const recordBefore = await fs.promises.lstat(filename, { bigint: true });
  const markerBefore = await fs.promises.lstat(markerFilename, { bigint: true });
  const files = [filename, markerFilename, ownerFile, ledger];
  const [recordValue, markerValue, ownerValue, approvalValue] = await traceAsync('private-set-initial', () =>
    readPrivateApprovalSetAsync(files, request.signal, ['record', 'marker', 'owner', 'ledger']));
  phase = 'private-binding';
  const record = recordSchema.parse(recordValue), marker = markerSchema.parse(markerValue);
  const initialOwner = ownerPolicySchema.parse(ownerValue), initialApprovals = trustedHostApprovalsSchema.parse(approvalValue);
  const initialGrant = initialApprovals.approvals.find(item => item.workspace === record.workspace && item.serverName === record.serverName);
  if (record.tokenHash !== key || record.issuedAt > Date.now() || record.expiresAt <= Date.now()
      || !identityFields.every(name => String(markerBefore[name]) === record.markerIdentity[name])
      || marker.version !== 1 || marker.generation !== record.generation || marker.state !== 'active'
      || marker.recordDev !== String(recordBefore.dev) || marker.recordIno !== String(recordBefore.ino)
      || hash(JSON.stringify(marker)) !== record.markerDigest
      || initialOwner.ownerId !== record.ownerId || ownerPolicyRevision(initialOwner) !== record.ownerRevision
      || initialApprovals.ownerId !== record.ownerId || !initialGrant || initialGrant.expiresAt <= Date.now()
      || initialGrant.policyDigest !== record.policyDigest) throw new BundledFlujoWorkloadError();
  const url = new URL(request.url);
  phase = 'request-binding';
  const assertBinding = (allowed: boolean, field: 'url-audience' | 'process-audience' | 'host' | 'origin' | 'workspace-header' | 'workspace-query' | 'inventory-route' | 'path') => {
    if (allowed) return;
    try { if (process.env.FLUJO_MCP_WORKLOAD_TRACE === '1') console.info('[workload-request-binding]', 'refused', field); } catch { /* Preserve refusal. */ }
    throw new BundledFlujoWorkloadError();
  };
  assertBinding(url.origin === record.audience, 'url-audience');
  assertBinding(audience(process.env.FLUJO_BASE_URL) === record.audience, 'process-audience');
  assertBinding(request.headers.get('host') === url.host, 'host');
  assertBinding(request.headers.get('origin') === null || request.headers.get('origin') === record.audience, 'origin');
  assertBinding(request.headers.get('x-flujo-workspace') === record.workspace, 'workspace-header');
  assertBinding(!url.searchParams.has('workspace'), 'workspace-query');
  assertBinding(record.inventory.some(item => item.path === url.pathname && item.method === request.method), 'inventory-route');
  assertBinding(!/%|\\|\/\//.test(url.pathname), 'path');
  await runWithWorkspace(record.workspace, async () => {
    phase = 'config';
    const first = await traceAsync('config-first', () => readCurrentConfig(record.serverName, request.signal));
    const config = await stdioLaunchForm(first.config);
    const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
    if (policy.bundledInstallation?.packageDirectory !== 'flujo') throw new BundledFlujoWorkloadError();
    phase = 'package';
    const approved = await traceAsync('package-verification', () => verifyTrustedHostMcp(config, request.signal));
    phase = 'inventory-binding';
    const inventory = await traceAsync('inventory', () => computeBundledFlujoWorkloadInventory());
    if (approved.ownerId !== record.ownerId || approved.digest !== record.policyDigest
        || canonicalWorkloadJson(policy.bundledInstallation.workload?.inventory) !== canonicalWorkloadJson(record.inventory)
        || canonicalWorkloadJson(inventory) !== canonicalWorkloadJson(record.inventory)) throw new BundledFlujoWorkloadError();
    phase = 'config-fences';
    const latest = await traceAsync('config-latest', () => readCurrentConfig(record.serverName, request.signal));
    if (!sameTrustedHostConsent(await stdioLaunchForm(latest.config), config)) throw new BundledFlujoWorkloadError();
    const finalEvidence = await traceAsync('config-final', () => readCurrentConfig(record.serverName, request.signal));
    const finalConfig = await stdioLaunchForm(finalEvidence.config);
    if (!sameTrustedHostConsent(finalConfig, config)) throw new BundledFlujoWorkloadError();
    const finalDigest = await traceAsync('digest-final', () => trustedHostMcpPolicyDigestAsync(finalConfig));
    // The last fresh set covers every private file after ALL yielding source,
    // executable, environment, inventory and config checks. No verdict is reused.
    phase = 'final-private-binding';
    // The reader waits briefly and reads the whole set again from scratch
    // while a failure may clear up (antivirus or the indexer holding a file).
    const [lastRecord, lastMarker, lastOwner, lastApprovals] = await traceAsync('private-set-final', () =>
      readPrivateApprovalSetAsync(files, request.signal, ['record', 'marker', 'owner', 'ledger']));
    const freshOwner = ownerPolicySchema.parse(lastOwner), approvals = trustedHostApprovalsSchema.parse(lastApprovals);
    const freshGrant = approvals.approvals.find(item => item.workspace === record.workspace && item.serverName === record.serverName);
    if (canonicalWorkloadJson(recordSchema.parse(lastRecord)) !== canonicalWorkloadJson(record)
        || canonicalWorkloadJson(markerSchema.parse(lastMarker)) !== canonicalWorkloadJson(marker)
        || freshOwner.ownerId !== record.ownerId || ownerPolicyRevision(freshOwner) !== record.ownerRevision
        || approvals.ownerId !== record.ownerId || !freshGrant || freshGrant.expiresAt <= Date.now()
        || freshGrant.policyDigest !== record.policyDigest || finalDigest !== record.policyDigest) throw new BundledFlujoWorkloadError();
    await finalEvidence.assertCurrent();
  });
  phase = 'final-file-fences';
  const recordAfter = await fs.promises.lstat(filename, { bigint: true });
  const markerAfter = await fs.promises.lstat(markerFilename, { bigint: true });
  if (!same(recordBefore, recordAfter) || !same(markerBefore, markerAfter) || isRevoking(key)
      || ledger !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE || ownerFile !== process.env.FLUJO_OWNER_AUTH_FILE
      || audience(process.env.FLUJO_BASE_URL) !== record.audience || record.expiresAt <= Date.now()) throw new BundledFlujoWorkloadError();
  request.signal.throwIfAborted();
  return record;
  } catch (error) {
    try {
      if (process.env.FLUJO_MCP_WORKLOAD_TRACE === '1') console.info('[workload-guard]', 'refused', phase);
    } catch { /* Diagnostics must preserve the original authorization failure. */ }
    throw error;
  }
}
export async function resolveBundledFlujoWorkloadRequest(request: Request): Promise<
  { kind: 'unrelated' } | { kind: 'denied'; response: Response } | { kind: 'authorized'; authorization: BundledFlujoWorkloadAuthorization }> {
  if (!/flo_mcp1_/i.test(request.headers.get('authorization') ?? '')) return { kind: 'unrelated' };
  try {
    const record = await evidence(request);
    const authorization: BundledFlujoWorkloadAuthorization = Object.freeze({ workspace: record.workspace, serverName: record.serverName,
      generation: record.generation, inventory: Object.freeze(record.inventory.map(item => Object.freeze(item))), readRequest: () => request,
      recheck: async () => { try { const current = await evidence(request); if (canonicalWorkloadJson(current) !== canonicalWorkloadJson(record)) return denied(); return null; } catch { return denied(); } } });
    principals.add(authorization); return { kind: 'authorized', authorization };
  } catch { return { kind: 'denied', response: denied() }; }
}
export async function assertBundledFlujoWorkloadCurrent(authorization: BundledFlujoWorkloadAuthorization, request: Request): Promise<void> {
  if (!principals.has(authorization) || request !== authorization.readRequest()) throw new BundledFlujoWorkloadError();
  // Load only for a genuine workload principal; ordinary effect guards return
  // before this import. Keep the adapter/context check on both sides of yields.
  const extensions = await import('@/backend/execution/extensions');
  const assertUnmixed = () => {
    const hasContext: unknown = Reflect.get(extensions, 'hasExecutionExtensionContext');
    if (typeof hasContext !== 'function' || extensions.executionExtensionAdapter() || hasContext()) throw new BundledFlujoWorkloadError();
  };
  assertUnmixed();
  if (await authorization.recheck()) throw new BundledFlujoWorkloadError();
  assertUnmixed();
}
export async function withBundledFlujoWorkloadAuthorization<T>(authorization: BundledFlujoWorkloadAuthorization, request: Request, handler: () => Promise<T>): Promise<T> {
  await assertBundledFlujoWorkloadCurrent(authorization, request);
  const inherited = originalWorkloadRequest();
  if (inherited && inherited !== request) throw new BundledFlujoWorkloadError();
  return AsyncLocalStorage.prototype.run.call(requestCarrier, request, () => context.run({ authorization, request }, handler)) as Promise<T>;
}
export function getAuthorizedBundledFlujoWorkloadToolNames(): readonly string[] | undefined {
  const selected = context.getStore(), request = originalWorkloadRequest();
  if (!selected && !request) return undefined;
  if (!selected || !request || selected.request !== request || !principals.has(selected.authorization)) throw new BundledFlujoWorkloadError();
  const protocol = new Set(['listTools', 'listResources', 'listResourceTemplates', 'readResource', 'listSkills', 'getSkill']);
  return selected.authorization.inventory.filter(item => !protocol.has(item.action)).map(item => item.action);
}
async function selectedWorkload() {
  const request = originalWorkloadRequest(), selected = context.getStore();
  if (!request && !selected) return undefined;
  if (!request) throw new BundledFlujoWorkloadError();
  if (selected) {
    if (selected.request !== request || !principals.has(selected.authorization)) throw new BundledFlujoWorkloadError();
    return selected;
  }
  const known = foreignRequestPrincipals.get(request);
  if (known) {
    if (!principals.has(known) || known.readRequest() !== request) throw new BundledFlujoWorkloadError();
    return { authorization: known, request };
  }
  const resolved = await resolveBundledFlujoWorkloadRequest(request);
  if (resolved.kind !== 'authorized' || originalWorkloadRequest() !== request) throw new BundledFlujoWorkloadError();
  foreignRequestPrincipals.set(request, resolved.authorization);
  return { authorization: resolved.authorization, request };
}
/** Effect guards retain the original admitted request and private ALS principal. */
export async function assertBundledFlujoWorkloadEffectCurrent(): Promise<void> {
  const selected = await selectedWorkload();
  if (selected) await assertBundledFlujoWorkloadCurrent(selected.authorization, selected.request);
}
export async function assertBundledFlujoWorkloadAction(action: string | readonly string[], method: string, route: string, args: unknown = {}): Promise<void> {
  const selected = await selectedWorkload(); if (!selected) return;
  await assertBundledFlujoWorkloadCurrent(selected.authorization, selected.request);
  const definitions = await computeBundledFlujoWorkloadDefinitions();
  const actions = typeof action === 'string' ? [action] : action;
  if (actions.length === 0) throw new BundledFlujoWorkloadError();
  const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv');
  const validator = new AjvJsonSchemaValidator();
  // These inventory/schema reads are synchronous. A group of metadata actions
  // shares the same fresh authority fences before and after validation.
  for (const name of actions) {
    const definition = definitions.find(item => item.action.action === name && item.action.method === method && item.action.path === route);
    if (!definition || !selected.authorization.inventory.some(item => canonicalWorkloadJson(item) === canonicalWorkloadJson(definition.action))) throw new BundledFlujoWorkloadError();
    if (!validator.getValidator(definition.schema)(args).valid) throw new BundledFlujoWorkloadError();
  }
  await assertBundledFlujoWorkloadCurrent(selected.authorization, selected.request);
}
const fixedJsonBodies = new WeakMap<Response, ReadableStream<Uint8Array>>();

/** Certify only the native, fixed body created here, never a caller-supplied stream. */
export function bundledFlujoWorkloadJsonResponse(value: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  if (response.body) fixedJsonBodies.set(response, response.body);
  return response;
}

export function bindBundledFlujoWorkloadStream(response: Response, authorization: BundledFlujoWorkloadAuthorization, signal: AbortSignal): Response {
  if (!response.body) return response;
  const body = response.body;
  const reader = body.getReader();
  if (fixedJsonBodies.get(response) === body) {
    // Native Response(string) contains one already serialized, immutable chunk.
    // Recheck immediately before publishing it; there is no producer effect or
    // later chunk/EOF to authorize. Arbitrary streams keep all their fences below.
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          await assertBundledFlujoWorkloadCurrent(authorization, authorization.readRequest());
          signal.throwIfAborted();
          if (!next.done) controller.enqueue(next.value);
          controller.close();
          reader.releaseLock();
        } catch (error) {
          try { await reader.cancel(error); } finally { reader.releaseLock(); controller.error(error); }
        }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted(); await assertBundledFlujoWorkloadCurrent(authorization, authorization.readRequest());
        const next = await reader.read();
        signal.throwIfAborted(); await assertBundledFlujoWorkloadCurrent(authorization, authorization.readRequest());
        if (next.done) { controller.close(); reader.releaseLock(); } else controller.enqueue(next.value);
      } catch (error) {
        try { await reader.cancel(error); } finally { reader.releaseLock(); controller.error(error); }
      }
    }, async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
