import { NextRequest } from 'next/server';

const assertLocalRequestMock = jest.fn();
const loadConversationStateMock = jest.fn();
const listRunResourcesMock = jest.fn();
const buildRunResourceUriMock = jest.fn();
const readRunResourceMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T,>(handler: T) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => loadConversationStateMock(...args),
}));

jest.mock('@/backend/services/runResources', () => ({
  listRunResources: (...args: unknown[]) => listRunResourcesMock(...args),
  buildRunResourceUri: (...args: unknown[]) => buildRunResourceUriMock(...args),
  readRunResource: (...args: unknown[]) => readRunResourceMock(...args),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}));

import { GET as listResources } from '@/app/v1/chat/conversations/[conversationId]/resources/route';
import { GET as readResource } from '@/app/v1/chat/conversations/[conversationId]/resources/[resourceId]/content/route';
import { RunResourceIndexPressureError } from '@/backend/services/runResources/indexCache';
import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';

const conversationContext = {
  params: Promise.resolve({ conversationId: 'conversation_persona' }),
};
const resourceContext = {
  params: Promise.resolve({ conversationId: 'conversation_persona', resourceId: 'resource_1' }),
};

function request(path: string) {
  return new NextRequest(`https://flujo.example.com${path}`);
}

describe('Persona run-resource HTTP boundaries', () => {
  it.each([
    ['CONVERSATION_LOG_READ_BUSY', 429],
    ['CONVERSATION_LOG_READ_MEMORY', 503],
  ] as const)('preserves %s for the shared HTTP wrapper before reading resources', async (code, status) => {
    const pressure = new ConversationLogReadPressureError(code, status);
    loadConversationStateMock.mockRejectedValue(pressure);
    await expect(listResources(request('/v1/chat/conversations/conversation_persona/resources'), conversationContext)).rejects.toBe(pressure);
    await expect(readResource(request('/v1/chat/conversations/conversation_persona/resources/resource_1/content'), resourceContext)).rejects.toBe(pressure);
    expect(listRunResourcesMock).not.toHaveBeenCalled();
    expect(readRunResourceMock).not.toHaveBeenCalled();
  });
  let ownershipMarkers: Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    ownershipMarkers = {
      personaAttribution: {
        personaId: 'persona_1',
        activityId: 'activity_1',
        behaviorRevisionId: 'revision_1',
      },
    };
    loadConversationStateMock.mockResolvedValue({
      conversationId: 'conversation_persona',
      ...ownershipMarkers,
    });
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
  });

  it('rejects Persona resource listing before reading the index', async () => {
    const req = request('/v1/chat/conversations/conversation_persona/resources');
    const response = await listResources(req, conversationContext);

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(req);
    expect(listRunResourcesMock).not.toHaveBeenCalled();
  });

  it('rejects Persona resource content before resolving or reading bytes', async () => {
    const req = request('/v1/chat/conversations/conversation_persona/resources/resource_1/content');
    const response = await readResource(req, resourceContext);

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(req);
    expect(buildRunResourceUriMock).not.toHaveBeenCalled();
    expect(readRunResourceMock).not.toHaveBeenCalled();
  });

  it.each([
    ['pending target', { personaTargetId: 'persona_1' }],
    ['frozen instruction context', { personaInstructionContext: { personaId: 'persona_1' } }],
    ['corrupt null attribution', { personaAttribution: null }],
    ['corrupt empty target', { personaTargetId: '' }],
  ])('fails closed for %s state before listing or reading resources', async (_label, markers) => {
    ownershipMarkers = markers;
    loadConversationStateMock.mockResolvedValue({
      conversationId: 'conversation_persona',
      ...ownershipMarkers,
    });

    const listReq = request('/v1/chat/conversations/conversation_persona/resources');
    const listResponse = await listResources(listReq, conversationContext);
    expect(listResponse.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(listReq);
    expect(listRunResourcesMock).not.toHaveBeenCalled();

    const contentReq = request('/v1/chat/conversations/conversation_persona/resources/resource_1/content');
    const contentResponse = await readResource(contentReq, resourceContext);
    expect(contentResponse.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(contentReq);
    expect(buildRunResourceUriMock).not.toHaveBeenCalled();
    expect(readRunResourceMock).not.toHaveBeenCalled();
  });

  it('returns actionable redacted index pressure after the local authority gate', async () => {
    assertLocalRequestMock.mockReturnValue(null);
    listRunResourcesMock.mockRejectedValueOnce(new RunResourceIndexPressureError());
    const response = await listResources(request('/v1/chat/conversations/conversation_persona/resources'), conversationContext);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(await response.json()).toEqual({ code: 'RUN_RESOURCE_INDEX_PRESSURE', retryable: true,
      error: 'Resource index reads are busy. Retry after current reads finish.' });
  });

  it('keeps unrelated index failures redacted and distinct from pressure', async () => {
    assertLocalRequestMock.mockReturnValue(null);
    listRunResourcesMock.mockRejectedValueOnce(new Error('private fixture index path'));
    const response = await listResources(request('/v1/chat/conversations/conversation_persona/resources'), conversationContext);
    expect(response.status).toBe(500);
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(await response.json()).toEqual({ error: 'Internal server error listing run resources' });
  });
});
