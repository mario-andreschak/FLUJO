import { NextRequest } from 'next/server';

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T,>(handler: T) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: jest.fn(() => null),
}));

jest.mock('@/config/features', () => ({
  FEATURES: { ENABLE_REVERT_TO_HERE: true },
}));

const baseState = {
  conversationId: 'conversation-1',
  status: 'paused_debug',
  messages: [{ id: 'message-1', role: 'user', content: 'hello' }],
};
let personaState: Record<string, unknown> = {
  ...baseState,
  personaAttribution: {
    personaId: 'persona-1',
    activityId: 'activity-1',
    behaviorRevisionId: 'revision-1',
  },
};
const loadConversationStateMock = jest.fn(async () => personaState);
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => loadConversationStateMock(...(args as [])),
}));

const persistConversationStateMock = jest.fn(async () => undefined);
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: (...args: unknown[]) => persistConversationStateMock(...(args as [])),
}));

const appendRawForStateMock = jest.fn(async () => undefined);
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  appendRawForState: (...args: unknown[]) => appendRawForStateMock(...(args as [])),
  readConversationLog: jest.fn(async () => []),
  projectMessages: jest.fn(() => []),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

const shadowRevertMock = jest.fn(async () => 'snapshot');
jest.mock('@/backend/services/snapshot/ShadowRepoService', () => ({
  shadowRepoService: {
    diff: jest.fn(async () => ''),
    revert: (...args: unknown[]) => shadowRevertMock(...(args as [])),
  },
  snapshotsEnabled: jest.fn(async () => true),
}));

import { PUT as replaceBreakpoints } from '@/app/v1/chat/conversations/[conversationId]/breakpoints/route';
import { PATCH as editState } from '@/app/v1/chat/conversations/[conversationId]/edit-state/route';
import { POST as attachDebugger } from '@/app/v1/chat/conversations/[conversationId]/debug/attach/route';
import { POST as revertConversation } from '@/app/v1/chat/conversations/[conversationId]/revert/route';

const context = { params: Promise.resolve({ conversationId: 'conversation-1' }) };

function request(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:4200${path}`, {
    method,
    headers: {
      host: 'localhost:4200',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const controlCases = [
  ['breakpoints', () => replaceBreakpoints(
    request('/v1/chat/conversations/conversation-1/breakpoints', 'PUT', { breakpoints: ['node-1'] }),
    context,
  )],
  ['edit-state', () => editState(
    request('/v1/chat/conversations/conversation-1/edit-state', 'PATCH', {
      messageId: 'message-1',
      content: 'changed',
    }),
    context,
  )],
  ['debug attach', () => attachDebugger(
    request('/v1/chat/conversations/conversation-1/debug/attach', 'POST'),
    context,
  )],
  ['revert', () => revertConversation(
    request('/v1/chat/conversations/conversation-1/revert', 'POST', {}),
    context,
  )],
] as const;

describe('Persona-owned legacy conversation controls', () => {
  beforeEach(() => {
    personaState = {
      ...baseState,
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
    };
    loadConversationStateMock.mockClear();
    persistConversationStateMock.mockClear();
    appendRawForStateMock.mockClear();
    shadowRevertMock.mockClear();
  });

  it.each(controlCases)('returns 409 before %s can mutate attributed state', async (_label, invoke) => {
    const response = await invoke();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('Persona dispatcher'),
    });
    expect(persistConversationStateMock).not.toHaveBeenCalled();
    expect(appendRawForStateMock).not.toHaveBeenCalled();
    expect(shadowRevertMock).not.toHaveBeenCalled();
  });

  it.each([
    ...controlCases.map(([control, invoke]) => [control, 'pending target', invoke, { personaTargetId: 'persona-1' }] as const),
    ...controlCases.map(([control, invoke]) => [control, 'instruction context', invoke, {
      personaInstructionContext: { personaId: 'persona-1' },
    }] as const),
    ...controlCases.map(([control, invoke]) => [control, 'null attribution', invoke, {
      personaAttribution: null,
    }] as const),
    ...controlCases.map(([control, invoke]) => [control, 'empty target', invoke, {
      personaTargetId: '',
    }] as const),
  ])('returns 409 before %s can mutate %s state', async (_control, _marker, invoke, markers) => {
    personaState = { ...baseState, ...markers };

    const response = await invoke();

    expect(response.status).toBe(409);
    expect(persistConversationStateMock).not.toHaveBeenCalled();
    expect(appendRawForStateMock).not.toHaveBeenCalled();
    expect(shadowRevertMock).not.toHaveBeenCalled();
  });
});
