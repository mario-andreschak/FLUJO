/**
 * Regression test for the frontend chatService.
 *
 * The Chat component previously issued inline `axios` calls against the
 * RESTful /v1/chat/conversations endpoints. That surface was extracted into
 * `chatService` (mirroring the flow/mcp/model service pattern, fetch-based) so
 * the component no longer talks HTTP directly. These tests drive the service
 * against a mocked `fetch`, asserting the verb/URL/body for each endpoint, the
 * 204 (no content) path, and that non-2xx responses map to a ChatApiError that
 * carries the status and the server's `error` message.
 */
import { chatService, ChatApiError } from '@/frontend/services/chat';

// Minimal Response stub matching what the service reads (ok/status/text()).
function makeResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

describe('chatService REST methods', () => {
  it('listConversations: GET /v1/chat/conversations', async () => {
    const list = [{ id: 'a', title: 'A', flowId: 'f', createdAt: 1, updatedAt: 2 }];
    fetchMock.mockResolvedValueOnce(makeResponse(200, list));

    const result = await chatService.listConversations();

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations');
    expect(result).toEqual(list);
  });

  it('getConversation: GET with encoded id', async () => {
    const conv = { id: 'x/y', title: 'T', messages: [], flowId: 'f', createdAt: 1, updatedAt: 2 };
    fetchMock.mockResolvedValueOnce(makeResponse(200, conv));

    const result = await chatService.getConversation('x/y');

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations/x%2Fy');
    expect(result).toEqual(conv);
  });

  it('getConversation: maps a 404 to ChatApiError with status', async () => {
    fetchMock.mockResolvedValue(makeResponse(404, { error: 'Conversation not found' }));

    await expect(chatService.getConversation('missing')).rejects.toMatchObject({
      name: 'ChatApiError',
      status: 404,
      message: 'Conversation not found',
    });
    await expect(chatService.getConversation('missing2')).rejects.toBeInstanceOf(ChatApiError);
  });

  it('createConversation: POST with JSON body', async () => {
    const payload = { id: 'n', title: 'New', flowId: 'f', createdAt: 1, updatedAt: 1 };
    fetchMock.mockResolvedValueOnce(makeResponse(201, { ...payload }));

    await chatService.createConversation(payload);

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  });

  it('updateConversationFlow: PATCH with only flowId', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { id: 'c', flowId: 'f2' }));

    await chatService.updateConversationFlow('c', 'f2');

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations/c', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ flowId: 'f2' }),
    }));
  });

  it('deleteConversation: resolves on 204 with no body', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(204));

    await expect(chatService.deleteConversation('c')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations/c', expect.objectContaining({
      method: 'DELETE',
    }));
  });

  it('respondToToolCall: POST action + toolCallId, returns parsed data', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { status: 'running' }));

    const data = await chatService.respondToToolCall('c', 'approve', 'tc1');

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations/c/respond', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'approve', toolCallId: 'tc1' }),
    }));
    expect(data).toEqual({ status: 'running' });
  });

  it('debugStep / debugContinue: POST to the debug routes', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { status: 'paused_debug' }));
    await chatService.debugStep('c');
    expect(fetchMock).toHaveBeenLastCalledWith('/v1/chat/conversations/c/debug/step', { method: 'POST' });

    fetchMock.mockResolvedValueOnce(makeResponse(200, { status: 'completed' }));
    await chatService.debugContinue('c');
    expect(fetchMock).toHaveBeenLastCalledWith('/v1/chat/conversations/c/debug/continue', { method: 'POST' });
  });

  it('setBreakpoints: PUT with breakpoints array', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { success: true, breakpoints: ['n1'] }));

    await chatService.setBreakpoints('c', ['n1']);

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations/c/breakpoints', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ breakpoints: ['n1'] }),
    }));
  });

  it('cancel: POST to the cancel route', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, {}));
    await chatService.cancel('c');
    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations/c/cancel', { method: 'POST' });
  });

  it('maps a 500 with an error body to ChatApiError carrying body + status', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, { error: 'boom' }));

    await chatService.cancel('c').then(
      () => { throw new Error('expected rejection'); },
      (err) => {
        expect(err).toBeInstanceOf(ChatApiError);
        expect(err.status).toBe(500);
        expect(err.message).toBe('boom');
        expect(err.body).toEqual({ error: 'boom' });
      }
    );
  });
});
