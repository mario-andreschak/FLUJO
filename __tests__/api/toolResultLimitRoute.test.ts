/**
 * /api/tool-result-limit (issue #1226): the Settings page reads and changes
 * the tool result size limit here. Saving keeps the other stored run-resource
 * settings, refuses bad input, and the very next tool call sees the change.
 */
const stored = new Map<string, unknown>();
const assertUnlockedMock = jest.fn();

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: jest.fn(async (key: string, fallback: unknown) => (stored.has(key) ? structuredClone(stored.get(key)) : fallback)),
  saveItem: jest.fn(async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); }),
}));
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));
jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

import { GET, PATCH } from '@/app/api/tool-result-limit/route';
import { _clearRunResourceSettingsCache, getRunResourceSettings } from '@/backend/services/runResources';
import { StorageKey } from '@/shared/types/storage';
import { makeLocalRequest } from '../utils/localRequest';

const KEY = StorageKey.RUN_RESOURCE_SETTINGS;

beforeEach(() => {
  stored.clear();
  _clearRunResourceSettingsCache();
  assertUnlockedMock.mockResolvedValue(null);
});

describe('/api/tool-result-limit', () => {
  it('shows the defaults: off, automatic, 256 KB custom value, 10,000 lines', async () => {
    const response = await GET(makeLocalRequest({ url: 'http://localhost/api/tool-result-limit' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: {
      toolResultTruncationEnabled: false, toolResultLimitMode: 'auto',
      toolResultMaxBytes: 256 * 1024, toolResultMaxLines: 10_000,
    } });
  });

  it('saves a change, keeps other stored settings and applies it to the next tool call at once', async () => {
    stored.set(KEY, { textThresholdChars: 4096 });
    // Warm the 30-second settings cache with the old value.
    expect((await getRunResourceSettings()).toolResultTruncationEnabled).toBe(false);

    const response = await PATCH(makeLocalRequest({ body: {
      toolResultTruncationEnabled: true, toolResultLimitMode: 'custom', toolResultMaxBytes: 32 * 1024, toolResultMaxLines: 500,
    } }));

    expect(response.status).toBe(200);
    expect((await response.json()).settings).toEqual({
      toolResultTruncationEnabled: true, toolResultLimitMode: 'custom', toolResultMaxBytes: 32 * 1024, toolResultMaxLines: 500,
    });
    expect(stored.get(KEY)).toEqual({
      textThresholdChars: 4096, toolResultTruncationEnabled: true, toolResultLimitMode: 'custom',
      toolResultMaxBytes: 32 * 1024, toolResultMaxLines: 500,
    });
    expect(await getRunResourceSettings()).toMatchObject({
      textThresholdChars: 4096, toolResultTruncationEnabled: true, toolResultMaxBytes: 32 * 1024,
    });
  });

  it('keeps a hand-set pre-#1226 byte limit as custom when only the switch changes', async () => {
    stored.set(KEY, { toolResultMaxBytes: 50_000 });
    const response = await PATCH(makeLocalRequest({ body: { toolResultTruncationEnabled: true } }));
    expect((await response.json()).settings).toMatchObject({ toolResultLimitMode: 'custom', toolResultMaxBytes: 50_000 });
    expect(stored.get(KEY)).toMatchObject({ toolResultLimitMode: 'custom' });
  });

  it.each([
    [{ toolResultMaxBytes: 10 }, 'invalid-size'],
    [{ toolResultLimitMode: 'huge' }, 'invalid-mode'],
    [{ maxConversationBytes: 1 }, 'unknown-field'],
  ])('refuses %j without saving', async (body, error) => {
    const response = await PATCH(makeLocalRequest({ body }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(error);
    expect(stored.has(KEY)).toBe(false);
  });

  it('refuses a cross-site caller', async () => {
    const response = await PATCH(makeLocalRequest({ origin: 'https://evil.example', body: { toolResultTruncationEnabled: true } }));
    expect(response.status).toBe(403);
    expect(stored.has(KEY)).toBe(false);
  });
});
