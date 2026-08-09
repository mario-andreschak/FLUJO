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
  it('countConversations: uses the lightweight presence endpoint', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { count: 3 }));

    const result = await chatService.countConversations();

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations?presence=1');
    expect(result).toBe(3);
  });

  it('listConversations: GET /v1/chat/conversations', async () => {
    const list = [{ id: 'a', title: 'A', flowId: 'f', createdAt: 1, updatedAt: 2 }];
    fetchMock.mockResolvedValueOnce(makeResponse(200, list));

    const result = await chatService.listConversations();

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations');
    expect(result).toEqual(list);
  });

  it('getConversationChains: GET the read-only chain projection (#405)', async () => {
    const chains = {
      chains: [{ rootId: 'r', title: 'R', updatedAt: 2, activeNodeCount: 1, totalNodeCount: 1, truncated: false, nodes: [] }],
      totalChains: 1,
      truncated: false,
      activeStatuses: ['running'],
      generatedAt: 5,
    };
    fetchMock.mockResolvedValueOnce(makeResponse(200, chains));

    const result = await chatService.getConversationChains();

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversation-chains', undefined);
    expect(result).toEqual(chains);
  });

  it('getConversationChains: encodes the root filter and forwards an abort signal', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { chains: [], totalChains: 0, truncated: false, activeStatuses: [], generatedAt: 1 }));
    const controller = new AbortController();

    await chatService.getConversationChains({ rootId: 'a b&c', limit: 3, signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/chat/conversation-chains?root=a+b%26c&limit=3',
      { signal: controller.signal },
    );
  });

  it('getConversationChains: maps a non-2xx response to ChatApiError', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(400, { error: 'Invalid root conversation id' }));

    await expect(chatService.getConversationChains({ rootId: 'nope' })).rejects.toMatchObject({
      name: 'ChatApiError',
      status: 400,
    });
  });

  it('listConversationPage: sends the cursor paging contract', async () => {
    const page = {
      items: [{ id: 'a', title: 'A', flowId: null, createdAt: 1, updatedAt: 2 }],
      total: 3,
      hasMore: true,
      nextCursor: 'next page',
    };
    fetchMock.mockResolvedValueOnce(makeResponse(200, page));

    const result = await chatService.listConversationPage({
      limit: 25,
      cursor: 'previous page',
      search: 'needle',
      dimension: 'content',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/chat/conversations?paged=1&limit=25&cursor=previous+page&search=needle&dimension=content',
    );
    expect(result).toEqual(page);
  });

  it('listConversationPage: forwards an abort signal without serializing it into the URL', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, {
      items: [], total: 0, hasMore: false,
    }));
    const controller = new AbortController();

    await chatService.listConversationPage({
      limit: 50,
      search: 'needle',
      dimension: 'title',
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/chat/conversations?paged=1&limit=50&search=needle&dimension=title',
      { signal: controller.signal },
    );
  });

  it('listConversationPage: sends origin and descendant filters to the backend', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, {
      items: [], total: 0, hasMore: false,
    }));

    await chatService.listConversationPage({
      limit: 50,
      origin: 'subflow',
      descendantsOf: 'parent-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/chat/conversations?paged=1&limit=50&origin=subflow&descendantsOf=parent-1',
    );
  });

  it('listAllConversationPages: follows cursors until the collection is complete', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200, {
        items: [{ id: 'a' }], total: 2, hasMore: true, nextCursor: 'cursor-2',
      }))
      .mockResolvedValueOnce(makeResponse(200, {
        items: [{ id: 'b' }], total: 2, hasMore: false,
      }));

    const result = await chatService.listAllConversationPages();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/v1/chat/conversations?paged=1&limit=200',
      '/v1/chat/conversations?paged=1&limit=200&cursor=cursor-2',
    ]);
    expect(result).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('listAllConversationPages: stops before requesting another page when aborted', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => {
        controller.abort();
        return JSON.stringify({
          items: [{ id: 'a' }], total: 2, hasMore: true, nextCursor: 'cursor-2',
        });
      },
    } as Response);

    await expect(chatService.listAllConversationPages({ signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('subscribeToSidebarEvents: uses the filtered global lifecycle stream', () => {
    const source = {
      onopen: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      close: jest.fn(),
    };
    const eventSourceMock = jest.fn(() => source);
    (global as any).EventSource = eventSourceMock;
    const onEvent = jest.fn();

    const result = chatService.subscribeToSidebarEvents({ onEvent });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'run:done',
        conversationId: 'conversation-1',
        status: 'completed',
        seq: 1,
        timestamp: 2,
      }),
    } as MessageEvent);

    expect(eventSourceMock).toHaveBeenCalledWith(
      '/v1/chat/events?scope=sidebar&workspace=default-workspace',
    );
    expect(result).toBe(source);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run:done',
      conversationId: 'conversation-1',
    }));
  });

  it('getConversation: GET with encoded id', async () => {
    const conv = { id: 'x/y', title: 'T', messages: [], flowId: 'f', createdAt: 1, updatedAt: 2 };
    fetchMock.mockResolvedValueOnce(makeResponse(200, conv));

    const result = await chatService.getConversation('x/y');

    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations/x%2Fy?compactToolPayloads=1');
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

  it('deleteConversations: DELETE collection route with ids body', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { deleted: 2, errors: 0 }));
    await chatService.deleteConversations(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledWith('/v1/chat/conversations', expect.objectContaining({
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['a', 'b'] }),
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

    fetchMock.mockResolvedValueOnce(makeResponse(200, { success: true }));
    await chatService.attachDebugger('c');
    expect(fetchMock).toHaveBeenLastCalledWith('/v1/chat/conversations/c/debug/attach', { method: 'POST' });
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
