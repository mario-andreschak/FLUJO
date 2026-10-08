import { render, screen, waitFor } from '@testing-library/react';

import { StorageProvider, useStorage } from '@/frontend/contexts/StorageContext';
import { StorageKey } from '@/utils/storage';

function SettingsProbe() {
  const { settings, settingsHydrated } = useStorage();
  return (
    <pre data-testid="settings">
      {JSON.stringify({ settings, settingsHydrated })}
    </pre>
  );
}

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

describe('StorageProvider fresh-install defaults', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('persists the enabled experimental defaults when settings are absent', async () => {
    const fetchMock = jest.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      if (url === '/api/init') return response({ success: true });
      if (url === '/api/encryption/secure') return response({ initialized: true });
      if (url === '/api/env?includeSecrets=false') return response({ variables: {} });
      if (url.startsWith('/api/storage?')) return response({ value: null });
      if (url === '/api/storage' && init?.method === 'POST') return response({ success: true });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(
      <StorageProvider>
        <SettingsProbe />
      </StorageProvider>,
    );

    await waitFor(() => {
      const value = JSON.parse(screen.getByTestId('settings').textContent ?? '{}');
      expect(value.settingsHydrated).toBe(true);
      expect(value.settings.experimental).toEqual({
        enabled: true,
        claudeSessionResume: true,
        autoUnloadOllamaModels: true,
        compactionEnabled: true,
        subflowDetachedInvocation: true,
        subflowSessions: true,
      });
    });

    const settingsWrite = fetchMock.mock.calls.find(([input, init]) => (
      String(input) === '/api/storage' && init?.method === 'POST'
    ));
    expect(settingsWrite).toBeDefined();
    expect(JSON.parse(String(settingsWrite?.[1]?.body))).toEqual({
      key: StorageKey.SPEECH_SETTINGS,
      value: expect.objectContaining({
        experimental: expect.objectContaining({
          enabled: true,
          claudeSessionResume: true,
          autoUnloadOllamaModels: true,
          compactionEnabled: true,
          subflowDetachedInvocation: true,
          subflowSessions: true,
        }),
      }),
    });
  });

  it('loads existing settings without merging or rewriting new defaults', async () => {
    const storedSettings = {
      speech: { enabled: false },
      update: { checkOnStartup: true },
      experimental: { enabled: false, claudeSessionResume: false },
    };
    const fetchMock = jest.fn(async (
      input: Parameters<typeof fetch>[0],
    ) => {
      const url = String(input);
      if (url === '/api/init') return response({ success: true });
      if (url === '/api/encryption/secure') return response({ initialized: true });
      if (url === '/api/env?includeSecrets=false') return response({ variables: {} });
      if (url.startsWith('/api/storage?')) return response({ value: storedSettings });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(
      <StorageProvider>
        <SettingsProbe />
      </StorageProvider>,
    );

    await waitFor(() => {
      const value = JSON.parse(screen.getByTestId('settings').textContent ?? '{}');
      expect(value.settingsHydrated).toBe(true);
      expect(value.settings).toEqual(storedSettings);
    });

    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/storage',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
