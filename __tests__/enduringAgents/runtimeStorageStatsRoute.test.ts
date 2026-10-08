const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();
const getPersonaStorageStatsMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }),
}));

jest.mock('@/backend/services/enduringAgents', () => ({
  PersonaStorageStatsNotFoundError: class PersonaStorageStatsNotFoundError extends Error {},
  PersonaStorageStatsUnavailableError: class PersonaStorageStatsUnavailableError extends Error {},
  getPersonaStorageStats: (...args: unknown[]) => getPersonaStorageStatsMock(...args),
}));

import { NextRequest, NextResponse } from 'next/server';

import {
  PersonaStorageStatsNotFoundError,
  PersonaStorageStatsUnavailableError,
} from '@/backend/services/enduringAgents';
import { GET } from '@/app/v1/personas/[personaId]/storage-stats/route';

const context = { params: Promise.resolve({ personaId: 'persona_test' }) } as never;

function request(): NextRequest {
  return new NextRequest('http://localhost:4200/v1/personas/persona_test/storage-stats', {
    headers: { host: 'localhost:4200' },
  });
}

describe('GET /v1/personas/:personaId/storage-stats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertLocalRequestMock.mockReturnValue(null);
    assertUnlockedMock.mockResolvedValue(null);
    getPersonaStorageStatsMock.mockResolvedValue({
      personaId: 'persona_test',
      retentionEnabled: false,
      collectedAt: 100,
      kinds: {
        mailboxItems: { total: 0, byStatus: {}, compacted: 0, uncompacted: 0, approxBytes: 0 },
        activities: { total: 0, byStatus: {}, compacted: 0, uncompacted: 0, approxBytes: 0 },
        flowDispatches: { total: 0, byStatus: {}, compacted: 0, uncompacted: 0, approxBytes: 0 },
        leaseHistory: { total: 0, byStatus: {}, compacted: 0, uncompacted: 0, approxBytes: 0 },
      },
      totals: { records: 0, compacted: 0, uncompacted: 0, approxBytes: 0 },
    });
  });

  it('uses local and unlocked-data guards and returns a no-store snapshot', async () => {
    const response = await GET(request(), context);

    expect(assertLocalRequestMock).toHaveBeenCalledTimes(1);
    expect(assertUnlockedMock).toHaveBeenCalledWith();
    expect(getPersonaStorageStatsMock).toHaveBeenCalledWith('persona_test');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(expect.objectContaining({
      personaId: 'persona_test',
      totals: { records: 0, compacted: 0, uncompacted: 0, approxBytes: 0 },
    }));
  });

  it('short-circuits non-local and locked requests with no-store responses', async () => {
    assertLocalRequestMock.mockReturnValueOnce(
      NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    );
    const forbidden = await GET(request(), context);
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('Cache-Control')).toBe('no-store');
    expect(assertUnlockedMock).not.toHaveBeenCalled();

    assertLocalRequestMock.mockReturnValueOnce(null);
    assertUnlockedMock.mockResolvedValueOnce(
      NextResponse.json({ error: 'encryption_locked' }, { status: 423 }),
    );
    const locked = await GET(request(), context);
    expect(locked.status).toBe(423);
    expect(locked.headers.get('Cache-Control')).toBe('no-store');
    expect(getPersonaStorageStatsMock).not.toHaveBeenCalled();
  });

  it('preserves the non-enumerating 404 contract for invalid and unknown Persona ids', async () => {
    const invalid = await GET(request(), {
      params: Promise.resolve({ personaId: '../private' }),
    } as never);
    expect(invalid.status).toBe(404);
    expect(await invalid.json()).toEqual({ error: 'Persona not found.' });

    getPersonaStorageStatsMock.mockRejectedValueOnce(
      new PersonaStorageStatsNotFoundError(),
    );
    const missing = await GET(request(), context);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Persona not found.' });
  });

  it('sanitizes validation and unexpected storage failures', async () => {
    getPersonaStorageStatsMock.mockRejectedValueOnce(
      new PersonaStorageStatsUnavailableError(),
    );
    const unavailable = await GET(request(), context);
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({
      error: 'Persona runtime storage statistics are unavailable.',
    });

    getPersonaStorageStatsMock.mockRejectedValueOnce(
      new Error('C:\\private\\runtime.json'),
    );
    const failed = await GET(request(), context);
    const body = await failed.json();
    expect(failed.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to collect Persona storage statistics.' });
    expect(JSON.stringify(body)).not.toContain('private');
  });
});
