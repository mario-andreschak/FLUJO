import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AsyncResource } from 'node:async_hooks';
import { modelService } from '@/backend/services/model';
import { getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { ensureWorkspaceDirs } from '@/utils/workspace';
import { installOwnerFixture } from '../utils/ownerFixture';
import { createOriginalOwnerAccount, enrollOriginalOwnerTask, revokeOriginalOwnerRecord,
  listOriginalOwnerRecords } from '@/backend/services/originalOwner/administration';
import { mutateOriginalOwnerBook, originalOwnerFilename, readOriginalOwnerBook } from '@/backend/services/originalOwner/store';
import { BookSchema, BudgetSchema } from '@/backend/services/originalOwner/types';
import type { Model, ModelOperationResponse } from '@/shared/types/model';

jest.mock('@/backend/services/enduringAgents/store', () => ({ getPersonaWorkItem: jest.fn() }));
// Crypto is separate from this real catalog/journal lock and recovery regression.
jest.mock('@/backend/services/model/encryption', () => ({
  encryptApiKey: jest.fn(async () => 'encrypted:fixture-sealed'),
  resolveAndDecryptApiKey: jest.fn(async (value: string) => value ? 'fixture-loopback-key' : null),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {}, verbose() {} }) }));

describe('Original account durable transfer and administrative recovery', () => {
  let directory: string;
  let owner: Awaited<ReturnType<typeof installOwnerFixture>>;
  const previous = process.env.FLUJO_DATA_DIR;
  const request = () => new Request('http://localhost/api/original-owner', { headers: owner.headers });
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-original-owner-administration-'));
    process.env.FLUJO_DATA_DIR = directory;
    await ensureWorkspaceDirs();
    owner = await installOwnerFixture(directory);
    jest.mocked(getPersonaWorkItem).mockResolvedValue({ id: 'task', personaId: 'persona',
      status: 'in_progress', goal: { state: 'active' } } as never);
    const added = await modelService.addModel({ id: 'model', name: 'fixture', adapter: 'openai',
      provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', ApiKey: 'encrypted:fixture-sealed' });
    expect(added.error).toBeUndefined();
    expect(added.success).toBe(true);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await owner.restore();
    if (previous === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const account = () => createOriginalOwnerAccount(request(), { modelId: 'model', routingHeaders: {} });
  const enroll = (id: string) => enrollOriginalOwnerTask(request(), { personaId: 'persona', taskId: 'task', accountId: id,
    budget: { maxModelSteps: null, maxOutputTokens: null }, allowedTools: [], commands: [] });

  it('transfers a credential under the real catalog lock, writes a private book and retries idempotently', async () => {
    const created = await account();
    expect(created.state).toBe('active');
    expect(await account()).toEqual(created);
    const model = await modelService.getModel('model');
    expect(model?.ApiKey).toBe('');
    expect(model?.ownerCredentialBinding?.credentialId).toBe(created.id);
    const book = BookSchema.parse(await readOriginalOwnerBook());
    expect(book.accounts).toHaveLength(1);
    expect(book.accounts[0].routingHeaders).toEqual({});
    expect(book.accounts[0].credential).toBe('encrypted:fixture-sealed');
    expect(await fs.readFile(originalOwnerFilename(), 'utf8')).not.toContain('fixture-loopback-key');
    if (process.platform !== 'win32') expect((await fs.stat(originalOwnerFilename())).mode & 0o077).toBe(0);
  });
  it('recovers a flushed pending account before the catalog update', async () => {
    const service = modelService as unknown as { updateModelWithinLease(model: Model): Promise<ModelOperationResponse> };
    const write = jest.spyOn(service, 'updateModelWithinLease')
      .mockResolvedValueOnce({ success: false, error: 'fixture catalog write failed' });
    await expect(account()).rejects.toMatchObject({ code: 'original_owner_model_binding_failed' });
    write.mockRestore();
    const pending = (await readOriginalOwnerBook()).accounts[0];
    expect(pending.state).toBe('pending');
    expect((await modelService.getModel('model'))?.ownerCredentialBinding).toBeUndefined();
    expect(await account()).toMatchObject({ id: pending.id, state: 'active' });
    expect((await readOriginalOwnerBook()).accounts).toHaveLength(1);
  });
  it('recovers a flushed pending account after the catalog update without losing the held credential', async () => {
    const created = await account();
    await mutateOriginalOwnerBook(async book => { book.accounts[0].state = 'pending'; });
    expect(await account()).toEqual(created);
    expect((await readOriginalOwnerBook()).accounts[0].credential).toBe('encrypted:fixture-sealed');
  });
  it('keeps a revoked account revoked on retry', async () => {
    const created = await account();
    await revokeOriginalOwnerRecord(request(), created.id);
    await expect(account()).rejects.toMatchObject({ code: 'original_owner_model_unavailable' });
  });
  it('reloads durable revocation when a callback escapes a completed journal scope', async () => {
    const created = await account();
    let readLater!: () => ReturnType<typeof readOriginalOwnerBook>;
    await mutateOriginalOwnerBook(async () => { readLater = AsyncResource.bind(() => readOriginalOwnerBook()); });
    await revokeOriginalOwnerRecord(request(), created.id);
    expect((await readLater()).accounts[0].state).toBe('revoked');
  });
  it('requires an explicit finite or unlimited budget and accepts optional closed routing headers', async () => {
    expect(BudgetSchema.safeParse({}).success).toBe(false);
    expect(BudgetSchema.safeParse({ maxModelSteps: null, maxOutputTokens: null }).success).toBe(true);
    const created = await createOriginalOwnerAccount(request(), { modelId: 'model', routingHeaders: { 'openai-project': 'project' } });
    expect(created.state).toBe('active');
    await expect(createOriginalOwnerAccount(request(), { modelId: 'model', routingHeaders: { authorization: 'forged' } }))
      .rejects.toBeDefined();
  });
  it.each(['sending', 'unknown'] as const)('does not erase an unresolved %s send by reenrolling a task', async state => {
    const created = await account(), enrollment = await enroll(created.id);
    await mutateOriginalOwnerBook(async book => { book.steps.push({ id: 'step', enrollmentId: enrollment.id,
      accountId: created.id, kind: 'model', originalRunId: 'run', leaseId: 'lease', modelDigest: 'a'.repeat(64),
      state, usage: null, createdAt: 1, updatedAt: 1 }); });
    await revokeOriginalOwnerRecord(request(), enrollment.id);
    await expect(enroll(created.id)).rejects.toMatchObject({ code: 'original_owner_outcome_unresolved' });
    const listing = await listOriginalOwnerRecords(request());
    expect(listing.steps).toHaveLength(1);
    expect(JSON.stringify(listing)).not.toContain('credential');
  });
});
