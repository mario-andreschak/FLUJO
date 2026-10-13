import type { NextRequest } from 'next/server';
import path from 'node:path';

const assertUnlockedMock = jest.fn(async () => undefined);
const assertLocalRequestMock = jest.fn((_request?: unknown, _options?: unknown): Response | null => null);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...(args as [])),
}));
jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (request: unknown, options?: unknown) => assertLocalRequestMock(request, options),
}));

const readConversationLogMock = jest.fn();
const projectMessagesMock = jest.fn();
const appendRawForStateMock = jest.fn(async (_state: unknown, _raws: unknown[]) => undefined);
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  withConversationLogEvents: async (id: string, consume: (events: unknown) => unknown) => jest.requireActual('@/backend/execution/flow/conversationLogReadAdmission').withConversationLogReadAdmission(100, async () => consume(await readConversationLogMock(id))),
  projectMessages: (...args: unknown[]) => projectMessagesMock(...args),
  projectModelContextMessages: (...args: unknown[]) => projectMessagesMock(...args),
  appendRawForState: (state: unknown, raws: unknown[]) => appendRawForStateMock(state, raws),
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
  snapshotsEnabled: jest.fn(async () => true),
}));

import { ConversationLogReadPressureError, getConversationLogReadAdmission } from '@/backend/execution/flow/conversationLogReadAdmission';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { GET, POST } from '@/app/v1/chat/conversations/[conversationId]/revert/route';

const CONVERSATION_ID = 'conversation-1';
const ROOT = path.resolve('repo');
const OTHER_ROOT = path.resolve('other-repo');

function chatMessage(id: string, role: 'user' | 'assistant' = 'assistant') {
  return { id, role, content: id, timestamp: id === 'm1' ? 1 : 2 };
}

function message(id: string, role: 'user' | 'assistant' = 'assistant') {
  return { type: 'message', message: chatMessage(id, role) };
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

function restore(body: Record<string, unknown>) {
  return POST(
    { json: async () => body } as unknown as NextRequest,
    { params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
  );
}

beforeEach(() => {
  assertUnlockedMock.mockClear();
  assertLocalRequestMock.mockReset().mockReturnValue(null);
  readConversationLogMock.mockReset();
  projectMessagesMock.mockReset();
  appendRawForStateMock.mockClear();
  jest.mocked(persistConversationState).mockClear();
  loadConversationStateMock.mockReset();
  diffMock.mockReset();
  revertMock.mockReset();
  loadConversationStateMock.mockResolvedValue({
    conversationId: CONVERSATION_ID,
    messages: [chatMessage('m1', 'user'), chatMessage('m2')],
    status: 'completed',
  });
  projectMessagesMock.mockReturnValue([chatMessage('m1', 'user'), chatMessage('m2')]);
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

  it('keeps chat restore available when file changes span multiple roots', async () => {
    readConversationLogMock.mockResolvedValue([
      message('m1'),
      changedFiles('snapshot-before-m1', 'snapshot-after-m1', ['first.ts']),
      changedFiles('snapshot-before-other', 'snapshot-after-other', ['other.ts'], OTHER_ROOT),
    ]);

    const response = await preview('m1');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      fileRestoreAvailable: false,
      fileRestoreUnavailableReason: 'multiple-roots',
    });
    expect(diffMock).not.toHaveBeenCalled();
  });

  it('restores only chat without touching files', async () => {
    readConversationLogMock.mockResolvedValue([message('m1', 'user'), message('m2')]);
    const previewResponse = await preview('m1');
    const restorePreview = await previewResponse.json();

    const response = await restore({
      messageId: 'm1',
      previewId: restorePreview.previewId,
      mode: 'chat-only',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ restoredChat: true, restoredFiles: false });
    expect(revertMock).not.toHaveBeenCalled();
    expect(appendRawForStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [] }),
      [
        { type: 'message:removed', messageId: 'm1' },
        { type: 'message:removed', messageId: 'm2' },
      ],
    );
  });

  it('restores only files while leaving chat messages intact', async () => {
    readConversationLogMock.mockResolvedValue([
      message('m1', 'user'),
      changedFiles('before', 'after', ['file.ts']),
      message('m2'),
    ]);
    revertMock.mockResolvedValue('undo-files');
    const restorePreview = await (await preview('m1')).json();
    const state = await loadConversationStateMock.mock.results[0]?.value;

    const response = await restore({
      messageId: 'm1',
      previewId: restorePreview.previewId,
      mode: 'files-only',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ restoredChat: false, restoredFiles: true });
    expect(revertMock).toHaveBeenCalledWith(ROOT, 'before', ['file.ts']);
    expect(appendRawForStateMock).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(2);
  });

  it('restores chat and files together and can undo both immediately', async () => {
    const events = [
      message('m1', 'user'),
      changedFiles('before', 'after', ['file.ts']),
      message('m2'),
    ];
    readConversationLogMock.mockResolvedValue(events);
    revertMock.mockResolvedValueOnce('undo-files').mockResolvedValueOnce('redo-files');
    const restorePreview = await (await preview('m1')).json();

    const response = await restore({
      messageId: 'm1',
      previewId: restorePreview.previewId,
      mode: 'chat-and-files',
    });
    const result = await response.json();
    expect(result).toMatchObject({ restoredChat: true, restoredFiles: true });

    // Undo is allowed only while the projected chat still equals the restored head.
    projectMessagesMock.mockReturnValueOnce([]);
    const undoResponse = await restore({ action: 'undo', operationId: result.operationId });

    expect(undoResponse.status).toBe(204);
    expect(revertMock).toHaveBeenNthCalledWith(2, ROOT, 'undo-files', ['file.ts']);
    expect(appendRawForStateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
      [
        { type: 'message', message: chatMessage('m1', 'user') },
        { type: 'message', message: chatMessage('m2') },
      ],
    );
  });
});


describe('restore history admission', () => {
  it('retains reservation through preview and file/chat mutation persistence', async () => {
    readConversationLogMock.mockResolvedValue([message('m1', 'user'), changedFiles('before', 'after', ['file.ts']), message('m2')]);
    diffMock.mockImplementation(async () => { expect(getConversationLogReadAdmission().active).toBe(1); return 'diff'; });
    revertMock.mockImplementation(async () => { expect(getConversationLogReadAdmission().active).toBe(1); return 'undo'; });
    appendRawForStateMock.mockImplementationOnce(async () => { expect(getConversationLogReadAdmission().active).toBe(1); });
    jest.mocked(persistConversationState).mockImplementationOnce(async () => { expect(getConversationLogReadAdmission().active).toBe(1); });
    const plan = await (await preview('m1')).json();
    const response = await restore({ messageId: 'm1', previewId: plan.previewId, mode: 'chat-and-files' });
    expect(response.status).toBe(200);
    expect(getConversationLogReadAdmission()).toEqual({ active: 0, bytes: 0 });
  });

  it.each([429, 503] as const)('refuses restore under pressure (%s) without changing chat or files', async status => {
    const state = await loadConversationStateMock();
    const before = JSON.stringify(state);
    readConversationLogMock.mockRejectedValueOnce(new ConversationLogReadPressureError(status === 429 ? 'CONVERSATION_LOG_READ_BUSY' : 'CONVERSATION_LOG_READ_MEMORY', status));
    const response = await restore({ messageId: 'm1', previewId: 'unused', mode: 'chat-and-files' });
    expect(response.status).toBe(status);
    expect(JSON.stringify(state)).toBe(before);
    expect(diffMock).not.toHaveBeenCalled(); expect(revertMock).not.toHaveBeenCalled();
    expect(appendRawForStateMock).not.toHaveBeenCalled(); expect(persistConversationState).not.toHaveBeenCalled();
    expect(getConversationLogReadAdmission()).toEqual({ active: 0, bytes: 0 });
  });

  it('holds undo admission through restored message append and rejects pressure before file undo', async () => {
    const state = await loadConversationStateMock();
    state.messages = [];
    state.revertOperations = { op: { mode: 'chat-and-files', root: ROOT, snapshotId: 'undo', paths: ['file.ts'], chatHeadMessageIds: [], chatTailMessageIds: ['m1'] } };
    projectMessagesMock.mockReturnValue([]);
    readConversationLogMock.mockRejectedValueOnce(new ConversationLogReadPressureError('CONVERSATION_LOG_READ_MEMORY', 503));
    expect((await restore({ action: 'undo', operationId: 'op' })).status).toBe(503);
    expect(revertMock).not.toHaveBeenCalled(); expect(appendRawForStateMock).not.toHaveBeenCalled();
    expect(state.revertOperations.op.undoneAt).toBeUndefined();
    readConversationLogMock.mockResolvedValueOnce([message('m1', 'user')]);
    revertMock.mockImplementationOnce(async () => { expect(getConversationLogReadAdmission().active).toBe(1); return 'redo'; });
    appendRawForStateMock.mockImplementationOnce(async () => { expect(getConversationLogReadAdmission().active).toBe(1); });
    expect((await restore({ action: 'undo', operationId: 'op' })).status).toBe(204);
    expect(state.messages.map((m: { id: string }) => m.id)).toEqual(['m1']);
    expect(getConversationLogReadAdmission()).toEqual({ active: 0, bytes: 0 });
  });
});
