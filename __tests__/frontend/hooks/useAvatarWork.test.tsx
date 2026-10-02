import { act, renderHook, waitFor } from '@testing-library/react';
import { useAvatarWork } from '@/frontend/components/AvatarWorld/useAvatarWork';
import { chatService } from '@/frontend/services/chat';
import { mcpService } from '@/frontend/services/mcp';
import type { Conversation } from '@/frontend/components/Chat';
import type { EventStreamHandlers } from '@/frontend/services/chat';
jest.mock('@/frontend/services/chat', () => ({ chatService: { getConversation: jest.fn(), createConversation: jest.fn(), synthesizeQuickChat: jest.fn(), subscribeToEvents: jest.fn(), cancel: jest.fn() } }));
jest.mock('@/frontend/services/mcp', () => ({ mcpService: { loadServerConfigs: jest.fn() } }));
const context = async () => ({ scopeId: 'panel:model:m', pageType: 'model' as const, route: '/models', title: 'Model', data: { name: 'Unsaved name' } });
const canonical = (status: Conversation['status'] = 'completed'): Conversation => ({ id: 'conversation', title: 'World', messages: [], flowId: 'quickchat-conversation', createdAt: 1, updatedAt: 2, status });
describe('avatar work uses the existing runtime', () => {
  let fetchMock: jest.Mock;
  let handlers: EventStreamHandlers;
  beforeEach(() => {
    jest.clearAllMocks(); window.localStorage.clear();
    fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    global.fetch = fetchMock;
    jest.mocked(chatService.getConversation).mockResolvedValue(canonical());
    jest.mocked(chatService.synthesizeQuickChat).mockResolvedValue({ conversationId: 'conversation', flow: { id: 'quickchat-conversation', name: 'World', nodes: [], edges: [] } });
    jest.mocked(chatService.subscribeToEvents).mockImplementation((_id, received) => { handlers = received; return { close: jest.fn() } as unknown as EventSource; });
    jest.mocked(mcpService.loadServerConfigs).mockResolvedValue([
      { name: 'My renamed Flujo', source: { type: 'npm', id: '@mario.andreschak/mcp-flujo' }, disabled: false },
      { name: 'Disabled Bash', source: { type: 'npm', id: '@mario.andreschak/mcp-bash' }, disabled: true },
      { name: 'flujo', source: { type: 'npm', id: 'unrelated-package' } },
    ] as never);
  });
  it('binds the chosen work model only to a new snapshot and uses renamed shipped connections', async () => {
    const { result } = renderHook(() => useAvatarWork({ modelId: 'chosen-brain', locale: 'es', context }));
    await act(() => result.current.send('Build me an agent'));
    expect(chatService.synthesizeQuickChat).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'chosen-brain', servers: [{ name: 'My renamed Flujo' }] }));
    expect(chatService.createConversation).toHaveBeenCalledTimes(1);
    const completion = fetchMock.mock.calls.find(([url]) => url === '/v1/chat/completions');
    const body = JSON.parse(completion![1].body);
    expect(body.metadata).toMatchObject({ appendMessages: 'true' });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toContain('Unsaved name');
    await act(() => result.current.send('Now explain it'));
    expect(chatService.createConversation).toHaveBeenCalledTimes(1);
  });
  it('never turns an uncertain steering delivery into duplicate normal execution', async () => {
    const { result } = renderHook(() => useAvatarWork({ modelId: 'chosen-brain', locale: 'es', context }));
    await act(() => result.current.send('Work'));
    jest.mocked(chatService.getConversation).mockResolvedValue(canonical('running'));
    act(() => handlers.onEvent({ type: 'run:start', seq: 1, timestamp: 1, conversationId: result.current.conversation!.id, flowId: 'quickchat-conversation' }));
    // Use the actual generated conversation id for the event channel.
    const createdId = jest.mocked(chatService.createConversation).mock.calls[0][0].id;
    act(() => handlers.onEvent({ type: 'run:start', seq: 2, timestamp: 2, conversationId: createdId, flowId: 'quickchat-conversation' }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await act(() => result.current.send('Use a different approach'));
    expect(fetchMock.mock.calls.filter(([url]) => url === '/v1/chat/completions')).toHaveLength(1);
    expect(result.current.error).toContain('confirmar');
  });
  it('ignores duplicate and child-lane terminal events when presenting root work', async () => {
    const { result } = renderHook(() => useAvatarWork({ modelId: 'chosen-brain', locale: 'es', context }));
    await act(() => result.current.send('Work'));
    const id = jest.mocked(chatService.createConversation).mock.calls[0][0].id;
    act(() => handlers.onEvent({ type: 'run:start', seq: 10, timestamp: 1, conversationId: id, flowId: 'root' }));
    expect(result.current.phase).toBe('thinking');
    const reads = jest.mocked(chatService.getConversation).mock.calls.length;
    act(() => {
      handlers.onEvent({ type: 'run:done', seq: 11, timestamp: 2, conversationId: id, depth: 1, status: 'completed' });
      handlers.onEvent({ type: 'run:done', seq: 10, timestamp: 2, conversationId: id, status: 'completed' });
    });
    expect(result.current.phase).toBe('thinking');
    expect(chatService.getConversation).toHaveBeenCalledTimes(reads);
  });
  it('restores canonical state after reload without creating or running another conversation', async () => {
    const { workspaceLocalStorageKey } = await import('@/frontend/utils/workspaceSelection');
    window.localStorage.setItem(workspaceLocalStorageKey('flujo-avatar:conversation'), 'existing');
    jest.mocked(chatService.getConversation).mockResolvedValue({ ...canonical('awaiting_tool_approval'), id: 'existing', messages: [{ id: 'answer', timestamp: 1, role: 'assistant', content: 'Waiting for your approval' }] });
    const { result } = renderHook(() => useAvatarWork({ modelId: 'chosen-brain', locale: 'es', context }));
    await waitFor(() => expect(result.current.phase).toBe('waiting'));
    expect(result.current.messages[0].text).toContain('approval');
    expect(chatService.createConversation).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
