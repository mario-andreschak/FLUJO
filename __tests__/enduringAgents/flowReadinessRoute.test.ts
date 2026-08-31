import { NextRequest } from 'next/server';

const assertUnlockedMock = jest.fn();
const assertLocalRequestMock = jest.fn();
const getFlowMock = jest.fn();
const validateFlowMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...args) },
}));

jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowObjectForRun: (...args: unknown[]) => validateFlowMock(...args),
}));

import { GET } from '@/app/v1/flows/[flowRef]/readiness/route';

function request(allowModelFallback = false): NextRequest {
  const query = allowModelFallback ? '?allowModelFallback=1' : '';
  return new NextRequest(`http://localhost:4200/v1/flows/shared_core/readiness${query}`);
}

const context = { params: Promise.resolve({ flowRef: 'shared_core' }) };

describe('Persona Flow readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(undefined);
    assertLocalRequestMock.mockReturnValue(undefined);
    getFlowMock.mockResolvedValue({
      id: 'shared_core',
      name: 'Shared Core',
      nodes: [],
      edges: [],
    });
  });

  it('allows only an unbound model issue when Persona creation can fill it', async () => {
    validateFlowMock.mockResolvedValue({
      isRunnable: false,
      errorCount: 1,
      warningCount: 0,
      issues: [{
        severity: 'error',
        code: 'process-missing-model',
        message: 'Process node "Coordinate" has no model bound.',
      }],
    });

    const ordinary = await GET(request(), context);
    expect(await ordinary.json()).toEqual({
      state: 'invalid',
      issues: ['Process node "Coordinate" has no model bound.'],
    });

    const personaCreation = await GET(request(true), context);
    expect(await personaCreation.json()).toEqual({ state: 'ready', issues: [] });
  });

  it('keeps deleted model references and structural errors blocking', async () => {
    validateFlowMock.mockResolvedValue({
      isRunnable: false,
      errorCount: 2,
      warningCount: 0,
      issues: [
        {
          severity: 'error',
          code: 'process-model-missing',
          message: 'The selected model no longer exists.',
        },
        {
          severity: 'error',
          code: 'finish-missing',
          message: 'Flow has no Finish node.',
        },
      ],
    });

    const response = await GET(request(true), context);
    expect(await response.json()).toEqual({
      state: 'invalid',
      issues: [
        'The selected model no longer exists.',
        'Flow has no Finish node.',
      ],
    });
  });
});
