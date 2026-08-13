import { NextRequest, NextResponse } from 'next/server';

const assertUnlockedMock = jest.fn();
const createDraftMock = jest.fn();
const getDraftMock = jest.fn();
const updateDraftMock = jest.fn();
const deleteDraftMock = jest.fn();
const listDraftsMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/backend/services/enduringAgents', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents');
  return {
    ...actual,
    createPersonaCreationDraft: (...args: unknown[]) => createDraftMock(...args),
    getPersonaCreationDraft: (...args: unknown[]) => getDraftMock(...args),
    updatePersonaCreationDraft: (...args: unknown[]) => updateDraftMock(...args),
    deletePersonaCreationDraft: (...args: unknown[]) => deleteDraftMock(...args),
    listPersonaCreationDrafts: (...args: unknown[]) => listDraftsMock(...args),
  };
});

import {
  DELETE,
  GET as GET_DRAFT,
  PATCH,
} from '@/app/v1/persona-drafts/[draftId]/route';
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

const context = {
  params: Promise.resolve({ draftId: 'draft_route' }),
};

describe('Persona draft routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(undefined);
    listDraftsMock.mockResolvedValue([]);
    getDraftMock.mockResolvedValue({ id: 'draft_route', revision: 2 });
    deleteDraftMock.mockResolvedValue(undefined);
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
      context,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'PERSONA_DRAFT_CONFLICT',
      details: { reason: 'STALE_REVISION', currentRevision: 3 },
    });
  });

  it('deletes a draft with its revision and treats a repeated delete as idempotent', async () => {
    const first = await DELETE(
      request('/v1/persona-drafts/draft_route', 'DELETE', {
        expectedRevision: 2,
      }),
      context,
    );
    const retry = await DELETE(
      request('/v1/persona-drafts/draft_route', 'DELETE', {
        expectedRevision: 2,
      }),
      context,
    );

    expect(first.status).toBe(204);
    expect(retry.status).toBe(204);
    expect(deleteDraftMock).toHaveBeenNthCalledWith(1, 'draft_route', {
      expectedRevision: 2,
    });
    expect(deleteDraftMock).toHaveBeenNthCalledWith(2, 'draft_route', {
      expectedRevision: 2,
    });
  });

  it('gates every draft operation behind the encryption lock', async () => {
    assertUnlockedMock.mockResolvedValue(
      NextResponse.json({ error: 'encryption_locked' }, { status: 423 }),
    );

    const responses = await Promise.all([
      GET(request('/v1/persona-drafts')),
      POST(request('/v1/persona-drafts', 'POST', {})),
      GET_DRAFT(request('/v1/persona-drafts/draft_route'), context),
      PATCH(
        request('/v1/persona-drafts/draft_route', 'PATCH', {}),
        context,
      ),
      DELETE(
        request('/v1/persona-drafts/draft_route', 'DELETE', {}),
        context,
      ),
    ]);

    expect(responses.map((response) => response.status))
      .toEqual([423, 423, 423, 423, 423]);
    expect(assertUnlockedMock).toHaveBeenCalledTimes(5);
    expect(listDraftsMock).not.toHaveBeenCalled();
    expect(createDraftMock).not.toHaveBeenCalled();
    expect(getDraftMock).not.toHaveBeenCalled();
    expect(updateDraftMock).not.toHaveBeenCalled();
    expect(deleteDraftMock).not.toHaveBeenCalled();
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
    expect(assertUnlockedMock).not.toHaveBeenCalled();
    expect(createDraftMock).not.toHaveBeenCalled();
  });
});
