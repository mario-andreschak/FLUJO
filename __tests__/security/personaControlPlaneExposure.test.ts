import { NextRequest } from 'next/server';

const mockParseRequestParameters = jest.fn();
const mockProcessChatCompletion = jest.fn();
const mockListPersonas = jest.fn();
const mockLoadConversationState = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T,>(handler: T) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  }),
}));

jest.mock('@/app/v1/chat/completions/requestParser', () => {
  class InvalidPersonaChatMetadataError extends Error {
    readonly code = 'invalid_persona_metadata';
  }
  return {
    InvalidPersonaChatMetadataError,
    parseRequestParameters: (...args: unknown[]) => mockParseRequestParameters(...args),
    _logRequestDetails: jest.fn(),
  };
});

jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({
  processChatCompletion: (...args: unknown[]) => mockProcessChatCompletion(...args),
}));

jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => mockLoadConversationState(...args),
}));

jest.mock('@/backend/services/enduringAgents', () => {
  class PersonaFactoryConflictError extends Error {}
  class RoleVersionNotFoundError extends Error {}
  return {
    PersonaFactoryConflictError,
    RoleVersionNotFoundError,
    createPersonaFromRole: jest.fn(),
    listPersonas: (...args: unknown[]) => mockListPersonas(...args),
  };
});

import { POST } from '@/app/v1/chat/completions/route';
import { GET as listPersonas } from '@/app/v1/personas/route';

const previousExposureMode = process.env.FLUJO_EXPOSURE_MODE;

function parsed(personaTarget?: { personaId: string }) {
  return {
    model: 'flow-support',
    messages: [{ role: 'user', content: 'Help me' }],
    stream: false,
    flujo: true,
    conversation_id: 'conversation-1',
    requireApproval: false,
    flujodebug: false,
    ...(personaTarget ? { personaTarget } : {}),
  };
}

function request(host: string, origin?: string) {
  const headers: Record<string, string> = {
    host,
    'content-type': 'application/json',
  };
  if (origin) headers.origin = origin;
  if (host !== 'localhost') headers['x-forwarded-for'] = `test-${host}`;
  return new NextRequest(`https://${host}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
}

describe('Persona selected-exposure control plane', () => {
  beforeEach(() => {
    process.env.FLUJO_EXPOSURE_MODE = 'public';
    mockParseRequestParameters.mockReset();
    mockLoadConversationState.mockReset().mockResolvedValue(undefined);
    mockListPersonas.mockReset().mockResolvedValue([{ id: 'persona_support' }]);
    mockProcessChatCompletion.mockReset().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterAll(() => {
    if (previousExposureMode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
    else process.env.FLUJO_EXPOSURE_MODE = previousExposureMode;
  });

  it('allows same-origin Persona selection in public mode and rejects cross-origin callers', async () => {
    mockParseRequestParameters.mockResolvedValueOnce(parsed({ personaId: 'persona_support' }));
    let response = await POST(request('flujo.example.com'));
    expect(response.status).toBe(200);
    expect(mockProcessChatCompletion).toHaveBeenCalledTimes(1);

    mockParseRequestParameters.mockResolvedValueOnce(parsed({ personaId: 'persona_support' }));
    response = await POST(request('flujo.example.com', 'https://attacker.example'));
    expect(response.status).toBe(403);
    expect(mockProcessChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('allows explicit Persona targeting from a loopback native client', async () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    mockParseRequestParameters.mockResolvedValue(parsed({ personaId: 'persona_support' }));
    const response = await POST(request('localhost'));

    expect(response.status).toBe(200);
    expect(mockProcessChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('allows Persona CRUD under the selected public exposure policy', async () => {
    let response = await listPersonas(request('flujo.example.com'));
    expect(response.status).toBe(200);
    expect(mockListPersonas).toHaveBeenCalledTimes(1);

    response = await listPersonas(request('flujo.example.com', 'https://attacker.example'));
    expect(response.status).toBe(403);
    expect(mockListPersonas).toHaveBeenCalledTimes(1);

    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    response = await listPersonas(request('localhost'));
    expect(response.status).toBe(200);
    expect(mockListPersonas).toHaveBeenCalledTimes(2);
  });

  it('applies ownership checks to same-origin Persona replay in public mode', async () => {
    mockLoadConversationState.mockResolvedValue({
      conversationId: 'conversation-1',
      personaAttribution: {
        personaId: 'persona_support',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
    });
    mockParseRequestParameters.mockResolvedValue({ ...parsed(), stream: true });

    const response = await POST(request('flujo.example.com'));
    expect(response.status).toBe(409);
    expect(mockProcessChatCompletion).not.toHaveBeenCalled();
  });

  it('requires a pending Persona draft target to match before dispatch', async () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    mockLoadConversationState.mockResolvedValue({
      conversationId: 'conversation-1',
      flowId: '',
      personaTargetId: 'persona_support',
    });

    mockParseRequestParameters.mockResolvedValueOnce(parsed());
    let response = await POST(request('localhost'));
    expect(response.status).toBe(409);

    mockParseRequestParameters.mockResolvedValueOnce(parsed({ personaId: 'persona_other' }));
    response = await POST(request('localhost'));
    expect(response.status).toBe(409);

    mockParseRequestParameters.mockResolvedValueOnce(parsed({ personaId: 'persona_support' }));
    response = await POST(request('localhost'));
    expect(response.status).toBe(200);
    expect(mockProcessChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('cannot convert an existing executed Flow conversation into a Persona conversation', async () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    mockLoadConversationState.mockResolvedValue({
      conversationId: 'conversation-1',
      flowId: 'flow-support',
      messages: [{ role: 'assistant', content: 'Already executed.' }],
      status: 'completed',
    });
    mockParseRequestParameters.mockResolvedValue(parsed({ personaId: 'persona_support' }));

    const response = await POST(request('localhost'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'persona_conversation_target_locked' },
    });
    expect(mockProcessChatCompletion).not.toHaveBeenCalled();
  });

  it('never resumes or retargets an anonymized Persona archive', async () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    mockLoadConversationState.mockResolvedValue({
      conversationId: 'conversation-1',
      flowId: 'flow-behavior',
      personaArchived: true,
    });
    mockParseRequestParameters.mockResolvedValue(parsed({ personaId: 'persona_support' }));

    const response = await POST(request('localhost'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'persona_conversation_archived' },
    });
    expect(mockProcessChatCompletion).not.toHaveBeenCalled();
  });

  it.each([
    ['instruction-only', { personaInstructionContext: { personaId: 'persona_support' } }],
    ['null-attribution', { personaAttribution: null }],
    ['empty-target', { personaTargetId: '' }],
  ])('fails closed instead of running a %s owned conversation', async (_label, markers) => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    mockLoadConversationState.mockResolvedValue({
      conversationId: 'conversation-1',
      flowId: 'flow-support',
      ...markers,
    });
    mockParseRequestParameters.mockResolvedValue(parsed({ personaId: 'persona_support' }));

    const response = await POST(request('localhost'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'persona_conversation_attribution_incomplete' },
    });
    expect(mockProcessChatCompletion).not.toHaveBeenCalled();
  });

  it.each([
    ['instruction-only', { personaInstructionContext: { personaId: 'persona_support' } }],
    ['null-attribution', { personaAttribution: null }],
    ['empty-target', { personaTargetId: '' }],
  ])('fails closed on incomplete %s ownership in public mode', async (_label, markers) => {
    mockLoadConversationState.mockResolvedValue({
      conversationId: 'conversation-1',
      flowId: 'flow-support',
      ...markers,
    });
    mockParseRequestParameters.mockResolvedValue(parsed());

    const response = await POST(request('flujo.example.com'));

    expect(response.status).toBe(409);
    expect(mockProcessChatCompletion).not.toHaveBeenCalled();
  });
});
