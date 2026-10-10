jest.mock('@/utils/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn() }) }));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: jest.fn(() => '/test-workspace') }));
jest.mock('@/backend/services/model/adapters/codexAuth', () => ({ readCodexAuthForTransfer: jest.fn() }));
jest.mock('@/backend/services/model/adapters/codexRuntimeHome', () => ({ prepareCodexRuntimeEnvironment: jest.fn(async () => ({ env: {}, workingDirectory: '/neutral' })) }));
jest.mock('@/backend/services/model/adapters/codexRuntimeUpdate', () => ({ acquireOrdinaryCodexExecutable: jest.fn(async () => ({ executable: '/qualified/codex', release: jest.fn(async () => {}) })) }));
jest.mock('@/backend/services/model/adapters/codexAppServerProcess', () => ({ startOwnedCodexAppServer: jest.fn(), assertCodexOwnedProcessRegistration: jest.fn() }));

import { fetchCodexModels, normalizeCodexModels } from '@/backend/services/model/adapters/codexDiscovery';
import { readCodexAuthForTransfer } from '@/backend/services/model/adapters/codexAuth';
import { startOwnedCodexAppServer } from '@/backend/services/model/adapters/codexAppServerProcess';
import { acquireOrdinaryCodexExecutable } from '@/backend/services/model/adapters/codexRuntimeUpdate';

const auth = jest.mocked(readCodexAuthForTransfer), start = jest.mocked(startOwnedCodexAppServer);
let request: jest.Mock, stop: jest.Mock;
let login = 0;
beforeEach(() => {
  jest.clearAllMocks(); login++;
  auth.mockImplementation(async () => Buffer.from(`account-${login}`));
  request = jest.fn(async (method, params) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ model: params.cursor ? 'brand-new-model' : 'gpt-6.1-sol', displayName: 'New model' }], nextCursor: params.cursor ? null : 'page-2' };
    return {};
  });
  stop = jest.fn(async () => {});
  start.mockResolvedValue({ request, stop, notify: jest.fn() } as unknown as Awaited<ReturnType<typeof startOwnedCodexAppServer>>);
});

it('lists all pages through the qualified CLI and never creates a thread, runs inference or invokes tools', async () => {
  const models = await fetchCodexModels();
  expect(models.map(row => row.id)).toEqual(['gpt-6.1-sol', 'brand-new-model']);
  expect(start.mock.calls[0][0]).toMatchObject({ executable: '/qualified/codex', args: ['app-server'], cwd: '/neutral' });
  expect(request.mock.calls.map(([method]) => method)).toEqual(['initialize', 'account/read', 'model/list', 'model/list']);
  expect(stop).toHaveBeenCalledTimes(1);
});

it('shares concurrent discovery, scopes the cache to login and CLI changes, and refreshes after expiry', async () => {
  await Promise.all([fetchCodexModels(), fetchCodexModels()]);
  expect(start).toHaveBeenCalledTimes(1);
  await fetchCodexModels(); expect(start).toHaveBeenCalledTimes(1);
  login++; await fetchCodexModels(); expect(start).toHaveBeenCalledTimes(2);
  jest.mocked(acquireOrdinaryCodexExecutable).mockResolvedValueOnce({ executable: '/new/codex', release: async () => {} });
  await fetchCodexModels(); expect(start).toHaveBeenCalledTimes(3);
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  try { await fetchCodexModels(); expect(start).toHaveBeenCalledTimes(4); }
  finally { now.mockRestore(); }
});

it('refuses changed accounts and cyclic pages, closes the child and does not cache failures', async () => {
  auth.mockResolvedValueOnce(Buffer.from('old')).mockResolvedValueOnce(Buffer.from('new'));
  await expect(fetchCodexModels()).rejects.toThrow('account changed');
  expect(stop).toHaveBeenCalledTimes(1);
  request.mockImplementation(async method => method === 'account/read' ? { account: { type: 'chatgpt' } }
    : method === 'model/list' ? { data: [], nextCursor: 'loop' } : {});
  await expect(fetchCodexModels()).rejects.toThrow('cursor');
  expect(stop).toHaveBeenCalledTimes(2);
});

it('does not start a child when the authoritative subscription login is absent', async () => {
  auth.mockRejectedValueOnce(new Error('missing'));
  await expect(fetchCodexModels()).rejects.toThrow('missing');
  expect(start).not.toHaveBeenCalled();
});

it('accepts future IDs and advertised capabilities, drops hidden/invalid models and never invents efforts', () => {
  expect(normalizeCodexModels([
    { model: 'future-7.9', displayName: 'Future', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }, { reasoningEffort: 'max' }, { reasoningEffort: 'invented' }], inputModalities: ['text'] },
    { model: 'hidden', hidden: true }, {}, null, { model: '' }, { model: 'legacy' },
  ])).toEqual([
    { id: 'future-7.9', name: 'Future', reasoningEfforts: ['ultra', 'max'], inputModalities: ['text'], visionInputCapability: 'unsupported' },
    { id: 'legacy', name: 'legacy' },
  ]);
});
