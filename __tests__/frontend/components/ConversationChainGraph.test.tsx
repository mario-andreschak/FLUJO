/**
 * Component tests for the experimental Chain Chat container.
 *
 * The real semantic tree is rendered here: these assertions cover loading,
 * selection, retry/truncation states, canonical navigation, and the lazy
 * inline-conversation request.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => '/chain-chat',
  useSearchParams: () => new URLSearchParams(),
}));

const mockGetConversationChains = jest.fn();
const mockGetConversation = jest.fn();
jest.mock('@/frontend/services/chat', () => ({
  chatService: {
    getConversationChains: (...args: unknown[]) => mockGetConversationChains(...args),
    getConversation: (...args: unknown[]) => mockGetConversation(...args),
  },
}));

jest.mock('@/frontend/components/Chat/ChatMarkdown', () => ({
  ChatMarkdownContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import ConversationChainGraph from '@/frontend/components/ConversationChainGraph';

const chainResponse = (overrides: Record<string, unknown> = {}) => ({
  chains: [
    {
      rootId: 'root 1',
      title: 'Root chain',
      updatedAt: 20,
      activeNodeCount: 1,
      totalNodeCount: 3,
      truncated: false,
      nodes: [
        {
          id: 'root 1',
          title: 'Root chain',
          status: 'completed',
          active: false,
          createdAt: 1,
          updatedAt: 10,
          parentConversationId: null,
          rootConversationId: null,
          lastMessage: { role: 'user', text: 'hello there', timestamp: 10, truncated: false },
        },
        {
          id: 'child-1',
          title: 'Child one',
          status: 'paused_debug',
          active: true,
          createdAt: 2,
          updatedAt: 20,
          parentConversationId: 'root 1',
          rootConversationId: 'root 1',
          lastMessage: {
            role: 'tool',
            text: 'read_file',
            toolName: 'read_file',
            toolKind: 'result',
            timestamp: 20,
            truncated: false,
          },
        },
        {
          id: 'child-2',
          title: 'Child two',
          status: 'completed',
          active: false,
          createdAt: 3,
          updatedAt: 15,
          parentConversationId: 'root 1',
          rootConversationId: 'root 1',
          lastMessage: null,
        },
      ],
    },
  ],
  totalChains: 1,
  truncated: false,
  activeStatuses: ['running', 'awaiting_tool_approval', 'paused_debug'],
  generatedAt: 99,
  ...overrides,
});

beforeEach(() => {
  mockPush.mockReset();
  mockGetConversationChains.mockReset();
  mockGetConversation.mockReset();
  mockGetConversation.mockResolvedValue({
    id: 'root 1',
    title: 'Root chain',
    flowId: null,
    createdAt: 1,
    updatedAt: 20,
    messages: [],
  });
});

describe('Chain Chat page container (#405)', () => {
  it('renders the projected family as a semantic top-down tree', async () => {
    mockGetConversationChains.mockResolvedValue(chainResponse());

    const { container } = render(<ConversationChainGraph />);

    const tree = await screen.findByTestId('chain-flow-tree');
    expect(tree).toHaveAttribute('data-layout', 'top-down');
    expect(screen.getByRole('region', { name: 'Top-down conversation flow' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-chain-id]')).toHaveLength(3);
    const root = container.querySelector('[data-chain-id="root 1"]');
    const child = container.querySelector('[data-chain-id="child-1"]');
    expect(child?.parentElement?.parentElement).toBe(root);
    expect(screen.getByTestId('chain-node-root 1')).toHaveTextContent('Root');
    expect(screen.getByTestId('chain-message-root 1')).toHaveTextContent('hello there');
    expect(screen.getByTestId('chain-message-child-1')).toHaveTextContent('Tool result ready');
    expect(screen.queryByRole('application')).toBeNull();

    expect(mockGetConversationChains).toHaveBeenCalledTimes(1);
    expect(mockGetConversationChains.mock.calls[0][0]).toHaveProperty('signal');
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  it('navigates through the canonical conversation magic link from the identity node', async () => {
    mockGetConversationChains.mockResolvedValue(chainResponse());

    render(<ConversationChainGraph />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open conversation: Root chain' }));

    expect(mockPush).toHaveBeenCalledWith('/chat?conversation=root+1');
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  it('loads the full conversation only after its adjacent message preview is expanded', async () => {
    mockGetConversationChains.mockResolvedValue(chainResponse());
    mockGetConversation.mockResolvedValue({
      id: 'root 1',
      title: 'Root chain',
      flowId: null,
      createdAt: 1,
      updatedAt: 20,
      messages: [
        { id: 'user-1', role: 'user', content: 'Full user message', timestamp: 1 },
        { id: 'assistant-1', role: 'assistant', content: 'Full assistant answer', timestamp: 2 },
      ],
    });

    render(<ConversationChainGraph />);
    const preview = await screen.findByRole('button', { name: 'Read conversation: Root chain' });
    expect(mockGetConversation).not.toHaveBeenCalled();

    fireEvent.click(preview);

    expect(mockGetConversation).toHaveBeenCalledWith('root 1');
    expect(await screen.findByRole('dialog', { name: 'Conversation preview: Root chain' })).toBeInTheDocument();
    expect(await screen.findByText('Full user message')).toBeInTheDocument();
    expect(screen.getByText('Full assistant answer')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows a neutral empty state before any conversation family exists', async () => {
    mockGetConversationChains.mockResolvedValue(chainResponse({ chains: [], totalChains: 0 }));

    render(<ConversationChainGraph />);

    expect(await screen.findByText('No conversation chains yet')).toBeInTheDocument();
    expect(screen.queryByTestId('chain-flow-tree')).toBeNull();
  });

  it('surfaces a recoverable error and retries the projection request', async () => {
    mockGetConversationChains
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(chainResponse());

    render(<ConversationChainGraph />);

    expect(await screen.findByText('Could not load the conversation chains')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('chain-flow-tree')).toBeInTheDocument();
    await waitFor(() => expect(mockGetConversationChains).toHaveBeenCalledTimes(2));
  });

  it('communicates partial data for capped chains and nodes', async () => {
    const response = chainResponse({ truncated: true, totalChains: 12 });
    response.chains[0].truncated = true;
    mockGetConversationChains.mockResolvedValue(response);

    render(<ConversationChainGraph />);

    expect(await screen.findByTestId('chain-flow-tree')).toBeInTheDocument();
    expect(screen.getByText(/most recently updated chains/i)).toBeInTheDocument();
    expect(screen.getByText(/most recently updated conversations/i)).toBeInTheDocument();
  });
});
