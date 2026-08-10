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
  beforeEach(() => {
    jest.clearAllMocks();
    loadConversationStateMock.mockResolvedValue({
      conversationId: 'conversation_persona',
      personaAttribution: {
        personaId: 'persona_1',
        activityId: 'activity_1',
        behaviorRevisionId: 'revision_1',
      },
    });
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
  });

  it('rejects Persona resource listing before reading the index', async () => {
    const req = request('/v1/chat/conversations/conversation_persona/resources');
    const response = await listResources(req, conversationContext);

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(req, { strictLoopback: true });
    expect(listRunResourcesMock).not.toHaveBeenCalled();
  });

  it('rejects Persona resource content before resolving or reading bytes', async () => {
    const req = request('/v1/chat/conversations/conversation_persona/resources/resource_1/content');
    const response = await readResource(req, resourceContext);

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(req, { strictLoopback: true });
    expect(buildRunResourceUriMock).not.toHaveBeenCalled();
    expect(readRunResourceMock).not.toHaveBeenCalled();
  });
});
