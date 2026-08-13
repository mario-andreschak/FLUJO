import { NextRequest } from 'next/server';

const createDraftMock = jest.fn();
const updateDraftMock = jest.fn();
const listDraftsMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => undefined),
}));

jest.mock('@/backend/services/enduringAgents', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents');
  return {
    ...actual,
    createPersonaCreationDraft: (...args: unknown[]) => createDraftMock(...args),
    updatePersonaCreationDraft: (...args: unknown[]) => updateDraftMock(...args),
    listPersonaCreationDrafts: (...args: unknown[]) => listDraftsMock(...args),
  };
});

import { PATCH } from '@/app/v1/persona-drafts/[draftId]/route';
import { GET, POST } from '@/app/v1/persona-drafts/route';
import { PersonaDraftConflictError } from '@/backend/services/enduringAgents';

function request(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:4200${path}`, {
    method,
    headers: {
      host: 'localhost:4200',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('Persona draft routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listDraftsMock.mockResolvedValue([]);
  });

  it('lists and creates drafts through a separate resource', async () => {
    const draft = { id: 'draft_route', revision: 1 };
    createDraftMock.mockResolvedValue(draft);

    const listResponse = await GET(request('/v1/persona-drafts'));
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([]);

    const createResponse = await POST(request(
      '/v1/persona-drafts',
      'POST',
      { id: 'draft_route', payload: {} },
    ));
    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toEqual(draft);
  });

  it('maps stale draft updates to HTTP 409 with stable details', async () => {
    updateDraftMock.mockRejectedValue(new PersonaDraftConflictError(
      'Changed elsewhere.',
      { reason: 'STALE_REVISION', currentRevision: 3 },
    ));

    const response = await PATCH(
      request('/v1/persona-drafts/draft_route', 'PATCH', {
        expectedRevision: 2,
        payload: {},
      }),
      { params: Promise.resolve({ draftId: 'draft_route' }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'PERSONA_DRAFT_CONFLICT',
      details: { reason: 'STALE_REVISION', currentRevision: 3 },
    });
  });

  it('rejects non-local draft writes before calling the service', async () => {
    const response = await POST(new NextRequest(
      'https://flujo.example.com/v1/persona-drafts',
      {
        method: 'POST',
        headers: {
          host: 'flujo.example.com',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    ));

    expect(response.status).toBe(403);
    expect(createDraftMock).not.toHaveBeenCalled();
  });
});
