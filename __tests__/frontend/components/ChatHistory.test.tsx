import { act, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import ChatHistory from '@/frontend/components/Chat/ChatHistory';

jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => ({ visualStyle: 'modern' }),
}));

describe('ChatHistory', () => {
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
