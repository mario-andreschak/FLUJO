/**
 * Component tests for the experimental Chain Chat container (issue #405).
 *
 * The React Flow canvas is mocked out (jsdom has no layout/ResizeObserver);
 * these tests cover the container contract instead: loading, empty, error +
 * retry, truncation notices, and — most importantly — that activating a bubble
 * navigates to the canonical `/chat?conversation=<id>` magic link.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => '/chain-chat',
  useSearchParams: () => new URLSearchParams(),
}));

const mockGetConversationChains = jest.fn();
jest.mock('@/frontend/services/chat', () => ({
  chatService: {
    getConversationChains: (...args: unknown[]) => mockGetConversationChains(...args),
  },
}));

// The canvas itself is exercised by the pure adapter unit tests; here it is a
// thin stand-in that exposes one button per node.
jest.mock('@/frontend/components/ConversationChainGraph/ChainGraphCanvas', () => ({
  __esModule: true,
  default: ({ nodes, onOpenConversation }: any) => (
    <div data-testid="chain-canvas">
      {nodes.map((node: any) => (
        <button key={node.id} type="button" onClick={() => onOpenConversation(node.id)}>
          {`open ${node.id}`}
        </button>
      ))}
    </div>
  ),
}));

import ConversationChainGraph from '@/frontend/components/ConversationChainGraph';

const chainResponse = (overrides: Record<string, unknown> = {}) => ({
  chains: [
    {
      rootId: 'root 1',
      title: 'Root chain',
      updatedAt: 20,
      activeNodeCount: 1,
      totalNodeCount: 2,
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
          title: 'Child',
          status: 'paused_debug',
          active: true,
          createdAt: 2,
          updatedAt: 20,
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
});

describe('Chain Chat page container (#405)', () => {
  it('renders the projected chain once loaded', async () => {
    mockGetConversationChains.mockResolvedValue(chainResponse());

    render(<ConversationChainGraph />);

    expect(await screen.findByTestId('chain-canvas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'open child-1' })).toBeInTheDocument();
    expect(mockGetConversationChains).toHaveBeenCalledTimes(1);
    // The request is abortable so a refresh/unmount can drop a stale response.
    expect(mockGetConversationChains.mock.calls[0][0]).toHaveProperty('signal');
  });

  it('navigates to the canonical conversation magic link when a bubble is activated', async () => {
    mockGetConversationChains.mockResolvedValue(chainResponse());

    render(<ConversationChainGraph />);
    fireEvent.click(await screen.findByRole('button', { name: 'open root 1' }));

    expect(mockPush).toHaveBeenCalledWith('/chat?conversation=root+1');
  });

  it('shows a neutral empty state before any conversation chain exists', async () => {
    mockGetConversationChains.mockResolvedValue(chainResponse({ chains: [], totalChains: 0 }));

    render(<ConversationChainGraph />);

    expect(await screen.findByText('No conversation chains yet')).toBeInTheDocument();
    expect(screen.queryByTestId('chain-canvas')).toBeNull();
  });

  it('surfaces a recoverable error and retries on request', async () => {
    mockGetConversationChains
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(chainResponse());

    render(<ConversationChainGraph />);

    expect(await screen.findByText('Could not load the conversation chains')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('chain-canvas')).toBeInTheDocument();
    await waitFor(() => expect(mockGetConversationChains).toHaveBeenCalledTimes(2));
  });

  it('communicates partial data for capped chains and nodes', async () => {
    const response = chainResponse({ truncated: true, totalChains: 12 });
    response.chains[0].truncated = true;
    mockGetConversationChains.mockResolvedValue(response);

    render(<ConversationChainGraph />);

    expect(await screen.findByTestId('chain-canvas')).toBeInTheDocument();
    expect(screen.getByText(/most recently updated chains/i)).toBeInTheDocument();
    expect(screen.getByText(/most recently updated conversations/i)).toBeInTheDocument();
  });
});
