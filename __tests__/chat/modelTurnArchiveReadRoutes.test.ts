import { NextRequest } from 'next/server';
import type { SharedState } from '@/backend/execution/flow/types';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { readModelTurnMedia, readModelTurnSnapshotResponse } from '@/backend/execution/flow/modelTurnArchive';
import { MODEL_TURN_ARCHIVE_READ_LIMITS, ModelTurnArchiveReadError } from '@/backend/execution/flow/modelTurnArchiveReadBudget';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { GET as snapshotGet } from '@/app/v1/chat/conversations/[conversationId]/model-turns/[dispatchId]/route';
import { GET as mediaGet } from '@/app/v1/chat/conversations/[conversationId]/model-turns/[dispatchId]/media/[mediaId]/route';

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationStateReadOnly: jest.fn() }));
jest.mock('@/backend/execution/flow/modelTurnArchive', () => ({ readModelTurnSnapshotResponse: jest.fn(), readModelTurnMedia: jest.fn() }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn() }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: jest.fn() }));

describe('model-turn archive read limit responses', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(assertUnlocked).mockResolvedValue(null);
    jest.mocked(assertLocalRequest).mockReturnValue(null);
    jest.mocked(loadConversationStateReadOnly).mockResolvedValue({ conversationId: 'conversation' } as SharedState);
  });

  const invoke = (route: 'snapshot' | 'media') => {
    const request = new NextRequest('http://localhost/v1/chat/conversations/conversation/model-turns/dispatch');
    const context = { params: Promise.resolve({ conversationId: 'conversation', dispatchId: 'dispatch', mediaId: 'media' }) };
    return route === 'snapshot' ? snapshotGet(request, context) : mediaGet(request, context);
  };

  const reader = (route: 'snapshot' | 'media') => route === 'snapshot'
    ? jest.mocked(readModelTurnSnapshotResponse) : jest.mocked(readModelTurnMedia);

  it.each([
    ['snapshot', 'MODEL_TURN_ARCHIVE_READ_LIMIT', 413],
    ['media', 'MODEL_TURN_ARCHIVE_READ_LIMIT', 413],
    ['snapshot', 'MODEL_TURN_ARCHIVE_READ_BUSY', 429],
    ['media', 'MODEL_TURN_ARCHIVE_READ_BUSY', 429],
  ] as const)('returns actionable %s/%s without exposing payloads', async (route, code, status) => {
    reader(route).mockRejectedValueOnce(new ModelTurnArchiveReadError(code, 'Inspection limit reached; persisted history is unchanged.'));
    const response = await invoke(route);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: 'Inspection limit reached; persisted history is unchanged.', code, limits: MODEL_TURN_ARCHIVE_READ_LIMITS,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBe(status === 429 ? '1' : null);
  });

  it.each(['snapshot', 'media'] as const)('keeps original storage failures distinct on %s', async route => {
    const error = Object.assign(new Error('unavailable'), { code: 'EACCES' });
    reader(route).mockRejectedValueOnce(error);
    await expect(invoke(route)).rejects.toBe(error);
  });

  it.each(['snapshot', 'media'] as const)('preserves missing-record 404 on %s', async route => {
    reader(route).mockResolvedValueOnce(undefined);
    expect((await invoke(route)).status).toBe(404);
  });

  it.each(['snapshot', 'media'] as const)('checks the conversation before reading %s', async route => {
    jest.mocked(loadConversationStateReadOnly).mockResolvedValueOnce(undefined);
    expect((await invoke(route)).status).toBe(404);
    expect(reader(route)).not.toHaveBeenCalled();
  });

  it.each(['snapshot', 'media'] as const)('passes the request cancellation signal to %s inspection', async route => {
    const request = new NextRequest('http://localhost/v1/chat/conversations/conversation/model-turns/dispatch');
    const context = { params: Promise.resolve({ conversationId: 'conversation', dispatchId: 'dispatch', mediaId: 'media' }) };
    reader(route).mockResolvedValueOnce(undefined);
    await (route === 'snapshot' ? snapshotGet(request, context) : mediaGet(request, context));
    if (route === 'snapshot') {
      expect(readModelTurnSnapshotResponse).toHaveBeenCalledWith('conversation', 'dispatch', request.signal);
    } else {
      expect(readModelTurnMedia).toHaveBeenCalledWith('conversation', 'dispatch', 'media', request.signal);
    }
  });
});
