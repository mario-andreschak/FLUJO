import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { PersonaDomainConflictError } from '@/backend/services/enduringAgents/domainMutation';

const addBehaviorMock = jest.fn();
const unlockMock = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: (...args: unknown[]) => unlockMock(...args) }));
jest.mock('@/backend/services/enduringAgents', () => ({
  ...jest.requireActual('@/backend/services/enduringAgents/domainMutation'),
  addPersonaCompositionBehavior: (...args: unknown[]) => addBehaviorMock(...args),
}));

import { POST } from '@/app/v1/personas/[personaId]/composition/behaviors/route';

function request(body: unknown, origin = 'http://localhost:4200') {
  return new NextRequest('http://localhost:4200/v1/personas/owner/composition/behaviors', {
    method: 'POST', headers: { host: 'localhost:4200', origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const context = { params: Promise.resolve({ personaId: 'owner' }) };

describe('add Persona Behavior route', () => {
  beforeEach(() => { jest.clearAllMocks(); unlockMock.mockResolvedValue(undefined); });

  it('forwards guarded input to the workspace-scoped operation', async () => {
    const input = { expectedUpdatedAt: 2, sourceFlowRef: 'specialist', mode: 'shared' };
    addBehaviorMock.mockResolvedValue({ personaRef: 'owner' });
    expect((await POST(request(input), context)).status).toBe(200);
    expect(addBehaviorMock).toHaveBeenCalledWith('owner', input);
  });

  it('rejects cross-origin writes, encryption locks and invalid Persona IDs before mutation', async () => {
    expect((await POST(request({}, 'https://external.example'), context)).status).toBe(403);
    unlockMock.mockResolvedValueOnce(NextResponse.json({}, { status: 423 }));
    expect((await POST(request({}), context)).status).toBe(423);
    expect((await POST(request({}), { params: Promise.resolve({ personaId: '../foreign' }) })).status).toBe(404);
    expect(addBehaviorMock).not.toHaveBeenCalled();
  });

  it('distinguishes invalid and stale requests without returning private error details', async () => {
    addBehaviorMock.mockRejectedValueOnce(new ZodError([]));
    expect((await POST(request({}), context)).status).toBe(400);
    addBehaviorMock.mockRejectedValueOnce(new PersonaDomainConflictError('Stale composition'));
    expect((await POST(request({}), context)).status).toBe(409);
    addBehaviorMock.mockRejectedValueOnce(new Error('private storage path'));
    const response = await POST(request({}), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to add Persona Behavior.' });
  });
});
