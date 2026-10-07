import { NextRequest, NextResponse } from 'next/server';

const prepareMock = jest.fn();
const unlockMock = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: (...args: unknown[]) => unlockMock(...args) }));
jest.mock('@/backend/services/enduringAgents/personaCorePreparation', () => ({
  PersonaCorePreparationConflictError: class extends Error {},
  reconcileDisabledPersonaCore: (...args: unknown[]) => prepareMock(...args),
}));

import { POST } from '@/app/v1/personas/[personaId]/core/reconcile/route';

const context = { params: Promise.resolve({ personaId: 'calma_supervisor' }) };
const body = { expectedCoreFlowRef: 'personaflow_core', expectedActiveRevisionId: 'revision_1' };
function request(origin = 'http://localhost:4200') {
  return new NextRequest('http://localhost:4200/v1/personas/calma_supervisor/core/reconcile', {
    method: 'POST', headers: { host: 'localhost:4200', origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('disabled Persona Core reconciliation route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    unlockMock.mockResolvedValue(undefined);
    prepareMock.mockResolvedValue({ personaId: 'calma_supervisor', revisionId: 'revision_2',
      contentHash: 'abc', dependencyCount: 54 });
  });

  it('returns only immutable revision metadata from native reconciliation', async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ personaId: 'calma_supervisor', revisionId: 'revision_2',
      contentHash: 'abc', dependencyCount: 54 });
    expect(prepareMock).toHaveBeenCalledWith({ personaId: 'calma_supervisor', ...body });
  });

  it('rejects non-loopback origin and encryption lock before reconciliation', async () => {
    expect((await POST(request('https://external.example'), context)).status).toBe(403);
    unlockMock.mockResolvedValueOnce(NextResponse.json({}, { status: 423 }));
    expect((await POST(request(), context)).status).toBe(423);
    expect(prepareMock).not.toHaveBeenCalled();
  });
});
