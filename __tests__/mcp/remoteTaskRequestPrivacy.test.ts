jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: jest.fn(),
  deleteCollectionItem: jest.fn(),
  listCollectionItems: jest.fn(),
  loadCollectionItem: jest.fn(),
  loadItem: jest.fn(),
  runInWriteChain: jest.fn(),
  saveCollectionItem: jest.fn(),
}));
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/utils/workspace', () => ({
  DEFAULT_WORKSPACE: 'default-workspace',
  getCurrentWorkspace: () => 'default-workspace',
  workspaceCacheKey: (key: string) => key,
}));

import { createHash } from 'node:crypto';
import { loadCollectionItem, runInWriteChain, saveCollectionItem } from '@/utils/storage/backend';
import {
  createRemoteTaskRecord, getRemoteTaskRecord, patchRemoteTaskRecord,
  type CreateRemoteTaskInput, type RemoteTaskPatch,
} from '@/backend/services/mcp/remoteTaskStore';
import { MCP_REMOTE_TASK_COLLECTION, type McpRemoteTaskRecord } from '@/shared/types/mcp/taskRecords';

const records = new Map<string, McpRemoteTaskRecord>();
const opaqueTag = /^request:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function input(args?: Record<string, unknown>): CreateRemoteTaskInput {
  return { remoteTaskId: 'synthetic-remote-task', serverName: 'public-server',
    serverIdentity: 'unchanged-server-identity', toolName: 'public-tool', args,
    ownership: { conversationId: 'public-conversation' }, status: 'working', pollIntervalMs: 1000 };
}

it('persists immutable protocol generation and leaves historical missing generation legacy', async () => {
  const modern = (await createRemoteTaskRecord({ ...input(), generation: '2026-07-28' }))!;
  const forged = await patchRemoteTaskRecord(modern.recordId, { generation: '2025-11-25' } as unknown as RemoteTaskPatch);
  expect(forged?.generation).toBe('2026-07-28');
  const legacy = (await createRemoteTaskRecord(input()))!;
  const patched = await patchRemoteTaskRecord(legacy.recordId, { generation: '2026-07-28', pollCount: 1 } as unknown as RemoteTaskPatch);
  expect(patched?.generation).toBeUndefined();
});

beforeEach(() => {
  jest.clearAllMocks();
  records.clear();
  jest.mocked(saveCollectionItem).mockImplementation(async (_collection, id, value) => {
    records.set(id, structuredClone(value) as McpRemoteTaskRecord);
  });
  jest.mocked(loadCollectionItem).mockImplementation(async <T>(_collection: string, id: string, fallback: T): Promise<T> => (
    records.has(id) ? structuredClone(records.get(id)) as T : fallback
  ));
  jest.mocked(runInWriteChain).mockImplementation((_key, operation) => operation());
});

it('new records persist independent opaque tags instead of a digest that validates password guesses', async () => {
  const args = { password: 'synthetic-pin-0042' };
  const oldDigest = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
  const created = await Promise.all([createRemoteTaskRecord(input(args)), createRemoteTaskRecord(input(args))]);
  for (const record of created) {
    expect(record).not.toBeNull();
    expect(record!.requestFingerprint).toMatch(opaqueTag);
    expect(record!.requestFingerprint).not.toBe(oldDigest);
    expect(JSON.stringify(record)).not.toContain(args.password);
    expect(record).not.toHaveProperty('args');
    expect(records.get(record!.recordId)?.requestFingerprint).toBe(record!.requestFingerprint);
  }
  expect(created[0]!.requestFingerprint).not.toBe(created[1]!.requestFingerprint);
  expect(saveCollectionItem).toHaveBeenCalledTimes(2);
});

it('never reads even the legacy args property at the durable record boundary', async () => {
  const supplied = input();
  const access = jest.fn(() => { throw new Error('synthetic argument access must not occur'); });
  Object.defineProperty(supplied, 'args', { enumerable: true, get: access });
  const record = await createRemoteTaskRecord(supplied);
  expect(record?.requestFingerprint).toMatch(opaqueTag);
  expect(access).not.toHaveBeenCalled();
  expect(saveCollectionItem).toHaveBeenCalledWith(MCP_REMOTE_TASK_COLLECTION, record?.recordId, record);
});

it('does not traverse a cyclic or hostile argument object while persisting task metadata', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  Object.defineProperty(cyclic, 'private', { enumerable: true, get: () => { throw new Error('synthetic private getter'); } });
  const record = await createRemoteTaskRecord(input(cyclic));
  expect(record?.requestFingerprint).toMatch(opaqueTag);
  expect(JSON.stringify(record)).not.toContain('private');
});

it('keeps new tags immutable through polling patches and reloaded records', async () => {
  const created = (await createRemoteTaskRecord(input({ password: 'synthetic-new-secret' })))!;
  const patched = await patchRemoteTaskRecord(created.recordId, {
    status: 'working', pollCount: 1, requestFingerprint: 'forged-request', serverIdentity: 'forged-server', generation: '2026-07-28',
  } as unknown as RemoteTaskPatch);
  const reloaded = await getRemoteTaskRecord(created.recordId);
  expect(patched?.requestFingerprint).toBe(created.requestFingerprint);
  expect(reloaded?.requestFingerprint).toBe(created.requestFingerprint);
  expect(reloaded?.serverIdentity).toBe(created.serverIdentity);
  expect(reloaded?.generation).toBe(created.generation);
  expect(reloaded?.pollCount).toBe(1);
});

it('retains legacy record identities without presenting them as remediated private tags', async () => {
  const created = (await createRemoteTaskRecord(input()))!;
  const legacy = { ...created, requestFingerprint: '0123456789abcdef' };
  records.set(legacy.recordId, legacy);
  expect((await getRemoteTaskRecord(legacy.recordId))?.requestFingerprint).toBe(legacy.requestFingerprint);
  const patched = await patchRemoteTaskRecord(legacy.recordId, { status: 'input_required' });
  expect(patched?.requestFingerprint).toBe(legacy.requestFingerprint);
  expect(patched?.serverIdentity).toBe(legacy.serverIdentity);
  expect(patched?.requestFingerprint).not.toMatch(opaqueTag);
});

it('preserves terminal immutability and the opaque identity through late cancellation', async () => {
  const created = (await createRemoteTaskRecord(input()))!;
  const completed = await patchRemoteTaskRecord(created.recordId, { status: 'completed' });
  const late = await patchRemoteTaskRecord(created.recordId, { status: 'cancelled' });
  expect(late?.status).toBe('completed');
  expect(late?.requestFingerprint).toBe(created.requestFingerprint);
  expect(late?.completedAt).toBe(completed?.completedAt);
  expect(saveCollectionItem).toHaveBeenCalledTimes(2);
});
