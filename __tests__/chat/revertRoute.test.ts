import type { NextRequest } from 'next/server';

const assertUnlockedMock = jest.fn(async () => undefined);
const assertLocalRequestMock = jest.fn((_request?: unknown, _options?: unknown): Response | null => null);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...(args as [])),
}));
jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (request: unknown, options?: unknown) => assertLocalRequestMock(request, options),
}));

jest.mock('@/config/features', () => ({
  FEATURES: { ENABLE_REVERT_TO_HERE: true },
}));

const readConversationLogMock = jest.fn();
const projectMessagesMock = jest.fn();
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  readConversationLog: (...args: unknown[]) => readConversationLogMock(...args),
  projectMessages: (...args: unknown[]) => projectMessagesMock(...args),
}));

const loadConversationStateMock = jest.fn();
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => loadConversationStateMock(...args),
}));

jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => undefined),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

const diffMock = jest.fn();
const revertMock = jest.fn();
jest.mock('@/backend/services/snapshot/ShadowRepoService', () => ({
  shadowRepoService: {
    diff: (...args: unknown[]) => diffMock(...args),
    revert: (...args: unknown[]) => revertMock(...args),
  },
}));

import { GET } from '@/app/v1/chat/conversations/[conversationId]/revert/route';

const CONVERSATION_ID = 'conversation-1';
const ROOT = 'C:\\repo';

function message(id: string) {
  return { type: 'message', message: { id } };
}

function changedFiles(startSnapshot: string, endSnapshot: string, files: string[], root = ROOT) {
  return {
    type: 'node:changed-files',
    root,
    startSnapshot,
    endSnapshot,
    changedFiles: files.map(path => ({ path, status: 'modified' })),
  };
}

function preview(messageId: string) {
  return GET(
    {
      nextUrl: new URL(`http://localhost:4200/v1/chat/conversations/${CONVERSATION_ID}/revert?messageId=${messageId}`),
    } as unknown as NextRequest,
    { params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
  );
}

beforeEach(() => {
  assertUnlockedMock.mockClear();
  assertLocalRequestMock.mockReset().mockReturnValue(null);
  readConversationLogMock.mockReset();
  projectMessagesMock.mockReset();
  loadConversationStateMock.mockReset();
  diffMock.mockReset();
  revertMock.mockReset();
  loadConversationStateMock.mockResolvedValue({ conversationId: CONVERSATION_ID });
  projectMessagesMock.mockReturnValue([{ id: 'm1' }, { id: 'm2' }]);
  diffMock.mockResolvedValue('combined diff');
});

describe('conversation revert route', () => {
  it('guards Persona previews before reading the event log or worktree', async () => {
    loadConversationStateMock.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      personaAttribution: {
        personaId: 'persona_1',
        activityId: 'activity_1',
        behaviorRevisionId: 'revision_1',
      },
    });
    assertLocalRequestMock.mockReturnValueOnce(new Response('forbidden', { status: 403 }));

    const response = await preview('m1');

    expect(response.status).toBe(403);
    expect(readConversationLogMock).not.toHaveBeenCalled();
    expect(diffMock).not.toHaveBeenCalled();
  });

  it('aggregates trusted changed-file events after the selected message boundary', async () => {
    readConversationLogMock.mockResolvedValue([
      message('m1'),
      changedFiles('snapshot-before-m1', 'snapshot-after-m1', ['first.ts', 'shared.ts']),
      message('m2'),
      changedFiles('snapshot-before-m2', 'snapshot-after-m2', ['second.ts', 'shared.ts']),
    ]);

    const response = await preview('m1');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.files).toEqual([
      { path: 'first.ts', status: 'modified' },
      { path: 'shared.ts', status: 'modified' },
      { path: 'second.ts', status: 'modified' },
    ]);
    expect(diffMock).toHaveBeenCalledWith(ROOT, 'snapshot-before-m1');
  });

  it('starts the forward window at the requested boundary', async () => {
    readConversationLogMock.mockResolvedValue([
      message('m1'),
      changedFiles('snapshot-before-m1', 'snapshot-after-m1', ['first.ts']),
      message('m2'),
      changedFiles('snapshot-before-m2', 'snapshot-after-m2', ['second.ts']),
    ]);

    const response = await preview('m2');

    expect(response.status).toBe(200);
    expect((await response.json()).files).toEqual([
      { path: 'second.ts', status: 'modified' },
    ]);
    expect(diffMock).toHaveBeenCalledWith(ROOT, 'snapshot-before-m2');
  });

  it('rejects ambiguous forward changes spanning multiple roots', async () => {
    readConversationLogMock.mockResolvedValue([
      message('m1'),
      changedFiles('snapshot-before-m1', 'snapshot-after-m1', ['first.ts']),
      changedFiles('snapshot-before-other', 'snapshot-after-other', ['other.ts'], 'D:\\other-repo'),
    ]);

    const response = await preview('m1');

    expect(response.status).toBe(404);
    expect(diffMock).not.toHaveBeenCalled();
  });
});
