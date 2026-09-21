import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

const readinessMock = jest.fn();
const unlockMock = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: (...args: unknown[]) => unlockMock(...args) }));
jest.mock('@/backend/services/enduringAgents/factory', () => ({
  getPersonaCreationReadiness: (...args: unknown[]) => readinessMock(...args),
  RoleVersionNotFoundError: class extends Error {},
}));

import { POST } from '@/app/v1/personas/readiness/route';
import { RoleVersionNotFoundError } from '@/backend/services/enduringAgents/factory';

function request(body: unknown, origin = 'http://localhost:4200') {
  return new NextRequest('http://localhost:4200/v1/personas/readiness', {
    method: 'POST', headers: { host: 'localhost:4200', origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Persona creation readiness route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    unlockMock.mockResolvedValue(undefined);
    readinessMock.mockResolvedValue({ state: 'ready', issues: [], models: ['Configured model'] });
  });

  it('returns the read-only setup check', async () => {
    const response = await POST(request({ roleVersionId: 'role' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'ready', issues: [], models: ['Configured model'] });
    expect(readinessMock).toHaveBeenCalledWith({ roleVersionId: 'role' });
  });

  it('rejects a cross-origin caller before reading setup', async () => {
    expect((await POST(request({}, 'https://external.example'))).status).toBe(403);
    expect(readinessMock).not.toHaveBeenCalled();
  });

  it('respects the encryption lock', async () => {
    unlockMock.mockResolvedValue(NextResponse.json({ error: 'encryption_locked' }, { status: 423 }));
    expect((await POST(request({}))).status).toBe(423);
    expect(readinessMock).not.toHaveBeenCalled();
  });

  it('distinguishes invalid input, missing Roles, and failed checks', async () => {
    readinessMock.mockRejectedValueOnce(new ZodError([]));
    expect((await POST(request({}))).status).toBe(400);
    readinessMock.mockRejectedValueOnce(new RoleVersionNotFoundError('missing'));
    expect((await POST(request({ roleVersionId: 'missing' }))).status).toBe(404);
    readinessMock.mockRejectedValueOnce(new Error('private storage detail'));
    const response = await POST(request({ roleVersionId: 'role' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Could not check Persona setup.' });
  });
});
