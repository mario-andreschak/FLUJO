import { kvGet, kvSet, _clearKvStoreSettingsCache } from '@/backend/services/kvStore';
import { writeFileAtomic } from '@/utils/storage/backend';
import { withHarnessExecution, type HarnessExecutionScope } from '@/backend/services/harness/executionScope';

jest.mock('fs', () => ({ promises: { readFile: jest.fn(async () => '[]'), mkdir: jest.fn() } }));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => '/unused', workspaceCacheKey: (...parts: string[]) => `harness-overlay/${parts.join('/')}` }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(async (_key, fallback) => fallback),
  writeFileAtomic: jest.fn(), runInWriteChain: async (_key: string, task: () => unknown) => task() }));

it('keeps captures available to later nodes without writing live KV state or contaminating another probe', async () => {
  _clearKvStoreSettingsCache();
  const resourceSnapshots = {};
  await withHarnessExecution({ resourceSnapshots } as HarnessExecutionScope, async () => {
    expect(await kvGet('global', 'example')).toBeUndefined();
    await expect(kvSet('global', 'example', 'candidate result')).resolves.toMatchObject({ value: 'candidate result' });
    expect(await kvGet('global', 'example')).toBe('candidate result');
  });
  await withHarnessExecution({ resourceSnapshots } as HarnessExecutionScope, async () => {
    expect(await kvGet('global', 'example')).toBeUndefined();
  });
  expect(await kvGet('global', 'example')).toBeUndefined();
  expect(writeFileAtomic).not.toHaveBeenCalled();
});
