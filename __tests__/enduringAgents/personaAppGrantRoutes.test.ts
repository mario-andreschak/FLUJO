const grantMock = jest.fn();
const listMock = jest.fn();
const revokeMock = jest.fn();
const launchMock = jest.fn();
const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/backend/services/enduringAgents', () => {
  class PersonaDomainNotFoundError extends Error {
    constructor(readonly recordKind: string, readonly recordId: string) {
      super(`${recordKind} ${JSON.stringify(recordId)} was not found.`);
    }
  }
  class PersonaDomainConflictError extends Error {}
  class PersonaDomainBusyError extends Error {}
  return {
    PersonaDomainNotFoundError,
    PersonaDomainConflictError,
    PersonaDomainBusyError,
    grantPersonaAppAccess: (...args: unknown[]) => grantMock(...args),
    listPersonaDirectAppGrants: (...args: unknown[]) => listMock(...args),
    revokePersonaAppAccess: (...args: unknown[]) => revokeMock(...args),
    authorizePersonaAppLaunch: (...args: unknown[]) => launchMock(...args),
  };
});

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { PersonaDomainNotFoundError } from '@/backend/services/enduringAgents';
import {
  GET as listPersonaAppGrants,
  POST as grantPersonaApp,
} from '@/app/v1/personas/[personaId]/app-grants/route';
import { DELETE as revokePersonaApp } from '@/app/v1/personas/[personaId]/app-grants/[grantId]/route';
import { POST as launchPersonaApp } from '@/app/v1/personas/[personaId]/app-grants/[grantId]/launch/route';

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);
const personaContext = { params: Promise.resolve({ personaId: 'jim' }) } as never;
const grantContext = {
  params: Promise.resolve({ personaId: 'jim', grantId: 'appgrant_123' }),
} as never;

beforeEach(() => {
  jest.clearAllMocks();
  assertLocalRequestMock.mockReturnValue(null);
  assertUnlockedMock.mockResolvedValue(null);
  listMock.mockResolvedValue([]);
});

describe('Persona direct-app grant routes', () => {
  it('lists, creates, authorizes, and revokes through workspace/local guarded APIs', async () => {
    const grant = { id: 'appgrant_123', personaId: 'jim', mcpServerName: 'github-jim' };
    listMock.mockResolvedValue([grant]);
    grantMock.mockResolvedValue(grant);
    launchMock.mockResolvedValue({
      personaId: 'jim',
      grantId: grant.id,
      mcpServerName: 'github-jim',
      uri: 'ui://github/dashboard',
    });
    revokeMock.mockResolvedValue(undefined);

    let response = await listPersonaAppGrants(
      request('/v1/personas/jim/app-grants') as never,
      personaContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([grant]);

    response = await grantPersonaApp(request('/v1/personas/jim/app-grants', {
      method: 'POST',
      body: JSON.stringify({ mcpServerName: 'github-jim' }),
    }) as never, personaContext);
    expect(response.status).toBe(201);
    expect(grantMock).toHaveBeenCalledWith('jim', { mcpServerName: 'github-jim' });

    response = await launchPersonaApp(request(
      '/v1/personas/jim/app-grants/appgrant_123/launch',
      { method: 'POST', body: JSON.stringify({ uri: 'ui://github/dashboard' }) },
    ) as never, grantContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mcpServerName: 'github-jim' });
    expect(launchMock).toHaveBeenCalledWith('jim', 'appgrant_123', {
      uri: 'ui://github/dashboard',
    });

    response = await revokePersonaApp(request(
      '/v1/personas/jim/app-grants/appgrant_123',
      { method: 'DELETE' },
    ) as never, grantContext);
    expect(response.status).toBe(204);
    expect(revokeMock).toHaveBeenCalledWith('jim', 'appgrant_123');
  });

  it('does not reveal a foreign grant and runs the local guard before domain access', async () => {
    launchMock.mockRejectedValue(
      new PersonaDomainNotFoundError('PersonaAppGrant', 'appgrant_sarah'),
    );
    let response = await launchPersonaApp(request(
      '/v1/personas/jim/app-grants/appgrant_sarah/launch',
      { method: 'POST', body: JSON.stringify({ uri: 'ui://github/dashboard' }) },
    ) as never, {
      params: Promise.resolve({ personaId: 'jim', grantId: 'appgrant_sarah' }),
    } as never);
    expect(response.status).toBe(404);

    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
    response = await listPersonaAppGrants(
      request('/v1/personas/jim/app-grants') as never,
      personaContext,
    );
    expect(response.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });
});
