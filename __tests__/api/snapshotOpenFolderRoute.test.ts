const openFolderMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/backend/services/snapshot/SnapshotStore', () => ({
  snapshotStore: {
    openFolder: (...args: unknown[]) => openFolderMock(...args),
  },
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

// Handler-level guard tests stay isolated here; real workspace selection is
// covered in workspaceRouteWrapper.test.ts.
jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

import { POST } from '@/app/api/snapshots/open-folder/route';
import { makeLocalRequest } from '../utils/localRequest';

describe('POST /api/snapshots/open-folder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(null);
    openFolderMock.mockResolvedValue(undefined);
  });

  it.each([
    { origin: null },
    { origin: 'http://localhost:4200' },
  ])('opens the active workspace snapshot root for a local request', async ({ origin }) => {
    const response = await POST(makeLocalRequest({
      url: 'http://localhost:4200/api/snapshots/open-folder',
      origin,
      body: { path: 'C:\\private\\attacker-controlled' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(openFolderMock).toHaveBeenCalledWith();
  });

  it.each([
    { host: 'evil.example', origin: null },
    { host: 'localhost:4200', origin: 'https://evil.example' },
  ])('rejects a non-local caller without launching', async ({ host, origin }) => {
    const response = await POST(makeLocalRequest({ host, origin }));

    expect(response.status).toBe(403);
    expect(openFolderMock).not.toHaveBeenCalled();
  });

  it('checks the encryption lock before locality or launch work', async () => {
    assertUnlockedMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'encryption_locked' }),
      { status: 423 },
    ));

    const response = await POST(makeLocalRequest({ host: 'evil.example' }));

    expect(response.status).toBe(423);
    expect(openFolderMock).not.toHaveBeenCalled();
  });

  it('does not expose the root or raw launcher errors', async () => {
    openFolderMock.mockRejectedValueOnce(
      new Error('C:\\private\\workspace\\snapshots launcher failed'),
    );

    const response = await POST(makeLocalRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'Unable to open snapshot folder' });
    expect(JSON.stringify(body)).not.toContain('private');
    expect(JSON.stringify(body)).not.toContain('launcher failed');
  });
});
