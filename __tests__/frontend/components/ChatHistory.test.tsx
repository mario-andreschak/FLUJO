import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import ChatHistory from '@/frontend/components/Chat/ChatHistory';
import type { ConversationListItem } from '@/frontend/components/Chat';
import { CONVERSATION_PINS_PREFERENCE } from '@/utils/shared/conversationPins';
import { readWorkspaceUiPreference, writeWorkspaceUiPreference } from '@/frontend/hooks/useUiPreference';

jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => ({ visualStyle: 'modern' }),
}));

describe('ChatHistory', () => {
  beforeEach(() => window.localStorage.clear());

  const parent: ConversationListItem = { id: 'parent', title: 'Parent run', flowId: 'flow-a', createdAt: 1, updatedAt: 1 };
  const child: ConversationListItem = { id: 'child', title: 'Child run', flowId: 'flow-b', createdAt: 2, updatedAt: 2, parentConversationId: 'parent', rootConversationId: 'parent' };
  const recent: ConversationListItem = { id: 'recent', title: 'Recent run', flowId: null, createdAt: 3, updatedAt: 3 };
  const pinProps = {
    conversations: [recent, child, parent],
    currentConversationId: null,
    onSelectConversation: jest.fn(),
    onDeleteConversation: jest.fn(),
    onBulkDelete: jest.fn(async () => undefined),
    onNewConversation: jest.fn(),
  };
  const rowIds = (element: Element) => Array.from(element.querySelectorAll('[data-conversation-id]'))
    .map((row) => row.getAttribute('data-conversation-id'));

  it.each(['none', 'chain', 'date', 'flow', 'origin'])('pins a family above other conversations in %s grouping and restores it after remount', (group) => {
    writeWorkspaceUiPreference('flujo-ui:chat-sidebar:group', group);
    const onPinsChanged = jest.fn();
    const onSelectConversation = jest.fn();
    const view = render(<ChatHistory {...pinProps} onPinsChanged={onPinsChanged} onSelectConversation={onSelectConversation} />);
    const parentRow = screen.getByText('Parent run').closest('[data-conversation-id]') as HTMLElement;
    fireEvent.click(within(parentRow).getByRole('button', { name: 'Pin conversation and children' }));

    expect(rowIds(screen.getByRole('group', { name: 'Pinned' }))).toEqual(['parent', 'child']);
    expect(rowIds(screen.getByRole('list', { name: 'Conversations' }))).toEqual(['parent', 'child', 'recent']);
    expect(screen.queryByText(/Child of/)).not.toBeInTheDocument();
    expect(onSelectConversation).not.toHaveBeenCalled();
    expect(onPinsChanged).toHaveBeenCalledTimes(1);
    expect(readWorkspaceUiPreference(CONVERSATION_PINS_PREFERENCE, [])).toEqual(['parent']);

    view.unmount();
    render(<ChatHistory {...pinProps} />);
    expect(rowIds(screen.getByRole('group', { name: 'Pinned' }))).toEqual(['parent', 'child']);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin conversation and children' }));
    expect(screen.queryByRole('group', { name: 'Pinned' })).not.toBeInTheDocument();
    expect(readWorkspaceUiPreference(CONVERSATION_PINS_PREFERENCE, [])).toEqual([]);
  });

  it('includes new descendants, supports independently pinned children, and keeps pins scoped to their workspace', () => {
    writeWorkspaceUiPreference(CONVERSATION_PINS_PREFERENCE, ['parent']);
    const view = render(<ChatHistory {...pinProps} />);
    const grandchild: ConversationListItem = { ...child, id: 'grandchild', title: 'Grandchild run', parentConversationId: 'child', updatedAt: 4 };
    view.rerender(<ChatHistory {...pinProps} conversations={[grandchild, ...pinProps.conversations]} />);
    expect(rowIds(screen.getByRole('group', { name: 'Pinned' }))).toEqual(['parent', 'child', 'grandchild']);

    const childRow = screen.getByText('Child run').closest('[data-conversation-id]') as HTMLElement;
    fireEvent.click(within(childRow).getByRole('button', { name: 'Pin conversation and children' }));
    const parentRow = screen.getByText('Parent run').closest('[data-conversation-id]') as HTMLElement;
    fireEvent.click(within(parentRow).getByRole('button', { name: 'Unpin conversation and children' }));
    expect(rowIds(screen.getByRole('group', { name: 'Pinned' }))).toEqual(['child', 'grandchild']);
    view.unmount();

    window.localStorage.setItem('flujo-ui:workspace', 'other-workspace');
    render(<ChatHistory {...pinProps} />);
    expect(screen.queryByRole('group', { name: 'Pinned' })).not.toBeInTheDocument();
  });

  it('keeps a child pinned when a filter hides its parent', () => {
    writeWorkspaceUiPreference(CONVERSATION_PINS_PREFERENCE, ['parent']);
    writeWorkspaceUiPreference('flujo-ui:chat-sidebar:status', 'running');
    render(<ChatHistory {...pinProps} conversations={[parent, { ...child, status: 'running' }]} />);
    expect(rowIds(screen.getByRole('group', { name: 'Pinned' }))).toEqual(['child']);
    expect(screen.queryByText('Parent run')).not.toBeInTheDocument();
  });

  it('keeps search visible while the filter controls can be expanded and hidden', () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <ChatHistory
          conversations={[]}
          currentConversationId={null}
          onSelectConversation={jest.fn()}
          onDeleteConversation={jest.fn()}
          onBulkDelete={jest.fn(async () => undefined)}
          onNewConversation={jest.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByPlaceholderText('Search title, origin, or agent…')).toBeVisible();
    const filterToggle = screen.getByRole('button', { name: /Filters and grouping/i });
    expect(filterToggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(filterToggle);
    expect(filterToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('combobox', { name: 'Filter by origin' })).toBeInTheDocument();

    fireEvent.click(filterToggle);
    expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByPlaceholderText('Search title, origin, or agent…')).toBeVisible();
  });

  it('offers another page when unloaded conversations remain', () => {
    const onLoadMore = jest.fn(async () => undefined);
    render(
      <ThemeProvider theme={createTheme()}>
        <ChatHistory
          conversations={[]}
          totalConversations={51}
          hasMoreConversations
          onLoadMore={onLoadMore}
          currentConversationId={null}
          onSelectConversation={jest.fn()}
          onDeleteConversation={jest.fn()}
          onBulkDelete={jest.fn(async () => undefined)}
          onNewConversation={jest.fn()}
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('keeps the delete action above the full-row conversation button', () => {
    const onDeleteConversation = jest.fn();
    const onSelectConversation = jest.fn();

    render(
      <ThemeProvider theme={createTheme()}>
        <ChatHistory
          conversations={[{
            id: 'conversation-1',
            title: 'Conversation one',
            flowId: null,
            createdAt: 1,
            updatedAt: 1,
            status: 'completed',
            source: 'chat',
          }]}
          currentConversationId="conversation-1"
          onSelectConversation={onSelectConversation}
          onDeleteConversation={onDeleteConversation}
          onBulkDelete={jest.fn(async () => undefined)}
          onNewConversation={jest.fn()}
        />
      </ThemeProvider>,
    );

    const deleteButton = screen.getByRole('button', { name: 'Delete conversation' });
    const secondaryAction = deleteButton.closest('.MuiListItemSecondaryAction-root');

    expect(secondaryAction).not.toBeNull();
    expect(secondaryAction).toHaveStyle({ zIndex: '2' });

    fireEvent.click(deleteButton);
    expect(onDeleteConversation).toHaveBeenCalledWith('conversation-1');
    expect(onSelectConversation).not.toHaveBeenCalled();
  });

  it('shows only the resolved session key on keyed conversation rows', () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <ChatHistory
          conversations={[
            {
              id: 'keyed', title: 'Keyed child', flowId: null,
              createdAt: 1, updatedAt: 2, status: 'completed', source: 'subflow',
              sessionKey: 'writer-main', sessionIdentity: 'parent::node::writer-main',
            },
            {
              id: 'legacy', title: 'Legacy child', flowId: null,
              createdAt: 1, updatedAt: 1, status: 'completed', source: 'subflow',
            },
          ]}
          currentConversationId={null}
          onSelectConversation={jest.fn()}
          onDeleteConversation={jest.fn()}
          onBulkDelete={jest.fn(async () => undefined)}
          onNewConversation={jest.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText('session: writer-main')).toBeInTheDocument();
    expect(screen.queryByText('parent::node::writer-main')).not.toBeInTheDocument();
  });

  it('offers parent-only or cascading deletion when a conversation has descendants', async () => {
    const onDeleteConversation = jest.fn();
    const onBulkDelete = jest.fn(async () => undefined);
    render(
      <ThemeProvider theme={createTheme()}>
        <ChatHistory
          conversations={[
            {
              id: 'parent', title: 'Parent run', flowId: null,
              createdAt: 1, updatedAt: 2, status: 'completed', source: 'chat',
            },
            {
              id: 'child', title: 'Child run', flowId: null,
              createdAt: 1, updatedAt: 1, status: 'completed', source: 'subflow',
              parentConversationId: 'parent', rootConversationId: 'parent',
            },
          ]}
          currentConversationId={null}
          onSelectConversation={jest.fn()}
          onDeleteConversation={onDeleteConversation}
          onBulkDelete={onBulkDelete}
          onNewConversation={jest.fn()}
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete conversation' })[0]);

    expect(await screen.findByRole('dialog', { name: 'Delete conversation family?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete parent only' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete parent and children (1)' }));

    expect(onBulkDelete).toHaveBeenCalledWith(['parent', 'child']);
    expect(onDeleteConversation).not.toHaveBeenCalled();
  });

  it('asks the backend for one search page and loads the next page only on demand', async () => {
    jest.useFakeTimers();
    const response = (body: unknown) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as Response);
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response({
        items: [{
          id: 'result-1', title: 'Alpha result', flowId: null,
          createdAt: 1, updatedAt: 2, status: 'completed', source: 'chat',
        }],
        total: 2,
        hasMore: true,
        nextCursor: 'next page',
      }))
      .mockResolvedValueOnce(response({
        items: [{
          id: 'result-2', title: 'Alpha follow-up', flowId: null,
          createdAt: 1, updatedAt: 1, status: 'completed', source: 'chat',
        }],
        total: 2,
        hasMore: false,
      }));
    (global as any).fetch = fetchMock;

    try {
      render(
        <ThemeProvider theme={createTheme()}>
          <ChatHistory
            conversations={[]}
            currentConversationId={null}
            onSelectConversation={jest.fn()}
            onDeleteConversation={jest.fn()}
            onBulkDelete={jest.fn(async () => undefined)}
            onNewConversation={jest.fn()}
          />
        </ThemeProvider>,
      );

      fireEvent.change(screen.getByPlaceholderText('Search title, origin, or agent…'), {
        target: { value: 'alpha' },
      });
      await act(async () => {
        jest.advanceTimersByTime(300);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        '/v1/chat/conversations?paged=1&limit=50&search=alpha&dimension=title',
        { signal: expect.any(AbortSignal) },
      );
      expect(screen.getByText('Alpha result')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        '/v1/chat/conversations?paged=1&limit=50&cursor=next+page&search=alpha&dimension=title',
        { signal: expect.any(AbortSignal) },
      );
      expect(screen.getByText('Alpha follow-up')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
