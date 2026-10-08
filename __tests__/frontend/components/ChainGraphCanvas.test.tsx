import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockGetConversation = jest.fn();

jest.mock('@/frontend/services/chat', () => ({
  chatService: {
    getConversation: (...args: unknown[]) => mockGetConversation(...args),
  },
}));

jest.mock('@/frontend/components/Chat/ChatMarkdown', () => ({
  ChatMarkdownContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const title = String(values?.title ?? '');
      const labels: Record<string, string> = {
        'chainChat.treeLabel': 'Conversation family',
        'chainChat.rootNode': 'Root',
        'chainChat.rootConversation': 'Main conversation',
        'chainChat.subflowNode': 'Subflow',
        'chainChat.latestMessage': 'Latest message',
        'chainChat.roleUser': 'You',
        'chainChat.roleAssistant': 'Assistant',
        'chainChat.roleTool': 'Tool',
        'chainChat.expandHint': 'Expand',
        'chainChat.statusRunning': 'Running',
        'chainChat.statusCompleted': 'Completed',
        'chainChat.statusUnknown': 'Unknown',
        'chainChat.openConversation': `Open conversation: ${title}`,
        'chainChat.expandConversation': `Expand conversation: ${title}`,
        'chainChat.transcriptLabel': `Conversation transcript: ${title}`,
        'chainChat.inlineConversation': 'Inline conversation',
        'chainChat.loadingConversation': 'Loading conversation',
        'chainChat.closeTranscript': 'Close transcript',
        'chainChat.openFullChat': 'Open full chat',
        'chainChat.toolCall': 'Tool call',
        'chainChat.toolResult': 'Tool result',
        'chainChat.toolActivity': 'Tool result ready',
        'chainChat.detachedNotice': 'Some conversations are detached',
        'chainChat.zoomControls': 'Map zoom',
        'chainChat.zoomOut': 'Zoom out',
        'chainChat.zoomIn': 'Zoom in',
        'chainChat.resetZoom': 'Reset zoom',
      };
      if (key === 'chainChat.messageCount') return `${values?.count ?? 0} messages`;
      return labels[key] ?? key;
    },
    formatDate: () => '10:00',
  }),
}));

import ChainFlowTree from '@/frontend/components/ConversationChainGraph/ChainFlowTree';
import { buildInlineTranscript } from '@/frontend/components/ConversationChainGraph/ChainTranscriptPopover';
import type { ConversationChainNode } from '@/shared/types/conversationChain';

const chainNode = (
  id: string,
  overrides: Partial<ConversationChainNode> = {},
): ConversationChainNode => ({
  id,
  title: id,
  status: 'completed',
  active: false,
  createdAt: 1,
  updatedAt: 1,
  parentConversationId: null,
  rootConversationId: null,
  lastMessage: { role: 'assistant', text: `Latest from ${id}`, timestamp: 1, truncated: false },
  ...overrides,
});

const nodes = [
  chainNode('root', { title: 'Root chat', messageCount: 7 }),
  chainNode('child-a', {
    title: 'Child A',
    parentConversationId: 'root',
    rootConversationId: 'root',
  }),
  chainNode('grandchild', {
    title: 'Grandchild',
    status: 'running',
    active: true,
    parentConversationId: 'child-a',
    rootConversationId: 'root',
  }),
  chainNode('child-b', {
    title: 'Child B',
    parentConversationId: 'root',
    rootConversationId: 'root',
    lastMessage: {
      role: 'tool',
      text: 'read_file',
      toolName: 'read_file',
      toolKind: 'result',
      timestamp: 2,
      truncated: false,
    },
  }),
];

describe('semantic Chain Flow tree', () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;

  beforeAll(() => {
    window.requestAnimationFrame = (callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(0), 0)
    );
    window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
    HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 10,
      y: 10,
      top: 10,
      left: 10,
      right: 210,
      bottom: 50,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    });
  });

  afterAll(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  beforeEach(() => {
    mockGetConversation.mockReset();
  });

  it('renders a centered top-down semantic hierarchy instead of a canvas', () => {
    const onOpenConversation = jest.fn();
    const { container } = render(
      <ChainFlowTree
        rootId="root"
        nodes={nodes}
        onOpenConversation={onOpenConversation}
        reducedMotion
      />,
    );

    expect(screen.getByTestId('chain-flow-tree')).toHaveAttribute('data-layout', 'top-down');
    expect(screen.getByRole('region', { name: 'Conversation family' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-chain-id]')).toHaveLength(4);
    const root = container.querySelector('[data-chain-id="root"]');
    const childA = container.querySelector('[data-chain-id="child-a"]');
    const grandchild = container.querySelector('[data-chain-id="grandchild"]');
    expect(childA?.parentElement?.parentElement).toBe(root);
    expect(grandchild?.parentElement?.parentElement).toBe(childA);
    expect(root).toHaveAttribute('data-branch-active', 'true');
    expect(container.querySelector('[data-chain-id="child-b"]')).toHaveAttribute('data-branch-active', 'false');
    expect(screen.queryByRole('application')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Child A' }));
    expect(onOpenConversation).toHaveBeenCalledWith('child-a');
  });

  it('shows the latest message beside each node, including tool activity', () => {
    render(
      <ChainFlowTree rootId="root" nodes={nodes} onOpenConversation={jest.fn()} reducedMotion />,
    );

    expect(screen.getByTestId('chain-message-root')).toHaveTextContent('Latest from root');
    expect(screen.getByTestId('chain-message-child-b')).toHaveTextContent('Tool');
    expect(screen.getByTestId('chain-message-child-b')).toHaveTextContent('Tool result ready');
    expect(screen.getByLabelText('7 messages')).toBeInTheDocument();
  });

  it('zooms with visible controls and resets to 100%', () => {
    const { container } = render(
      <ChainFlowTree rootId="root" nodes={nodes} onOpenConversation={jest.fn()} reducedMotion />,
    );

    const scene = container.querySelector('.chain-tree-scene');
    expect(scene).toHaveAttribute('data-zoom', '1.00');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scene).toHaveAttribute('data-zoom', '1.10');
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(scene).toHaveAttribute('data-zoom', '1.00');
    fireEvent.wheel(screen.getByTestId('chain-flow-viewport'), {
      ctrlKey: true,
      deltaY: -50,
      clientX: 100,
      clientY: 100,
    });
    expect(scene).toHaveAttribute('data-zoom', '1.10');
  });

  it('auto-hides a completed message preview after ten seconds', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-15T12:00:00Z'));
    const justCompleted = chainNode('done', {
      title: 'Done',
      updatedAt: Date.now(),
    });
    const { container } = render(
      <ChainFlowTree rootId="done" nodes={[justCompleted]} onOpenConversation={jest.fn()} reducedMotion />,
    );

    const composite = container.querySelector('.chain-node-composite');
    expect(composite).toHaveAttribute('data-completed-preview-hidden', 'false');
    act(() => jest.advanceTimersByTime(10_001));
    expect(composite).toHaveAttribute('data-completed-preview-hidden', 'true');
    jest.useRealTimers();
  });

  it('lazily loads, renders, closes, and caches an expanded inline transcript', async () => {
    let resolveConversation!: (value: unknown) => void;
    mockGetConversation.mockReturnValueOnce(new Promise((resolve) => {
      resolveConversation = resolve;
    }));
    const onOpenConversation = jest.fn();
    render(
      <ChainFlowTree
        rootId="root"
        nodes={nodes}
        onOpenConversation={onOpenConversation}
        reducedMotion
      />,
    );

    const preview = screen.getByRole('button', { name: 'Expand conversation: Root chat' });
    expect(preview).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(preview);

    expect(preview).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Conversation transcript: Root chat' })).toBeInTheDocument();
    expect(screen.getByText('Loading conversation')).toBeInTheDocument();
    expect(mockGetConversation).toHaveBeenCalledWith('root');

    await act(async () => {
      resolveConversation({
        id: 'root',
        title: 'Root chat',
        flowId: null,
        createdAt: 1,
        updatedAt: 4,
        messages: [
          { id: 'u1', role: 'user', content: 'Please inspect this', timestamp: 1 },
          {
            id: 'a1',
            role: 'assistant',
            content: 'Checking now',
            timestamp: 2,
            tool_calls: [{ id: 'call-1', function: { name: 'read_file' } }],
          },
          { id: 't1', role: 'tool', tool_call_id: 'call-1', content: 'file contents', timestamp: 3 },
          { id: 'a2', role: 'assistant', content: 'All done', timestamp: 4 },
        ],
      });
    });

    expect(await screen.findByText('Please inspect this')).toBeInTheDocument();
    expect(screen.getByText('Tool call · read file')).toBeInTheDocument();
    expect(screen.getByText(/read file · Tool result/)).toBeInTheDocument();
    expect(screen.getByText('All done')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close transcript' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(preview).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(preview);
    expect(await screen.findByText('All done')).toBeInTheDocument();
    expect(mockGetConversation).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open full chat' }));
    expect(onOpenConversation).toHaveBeenCalledWith('root');
  });

  it('builds a compact transcript with user, assistant, tool-call, and tool-result steps', () => {
    const steps = buildInlineTranscript([
      { id: 'u', role: 'user', content: 'Question', timestamp: 1 },
      {
        id: 'a',
        role: 'assistant',
        content: 'Working',
        timestamp: 2,
        tool_calls: [{ id: 'call', function: { name: 'search_files' } }],
      },
      { id: 't', role: 'tool', tool_call_id: 'call', content: 'Result', timestamp: 3 },
      { id: 'disabled', role: 'assistant', content: 'Hidden', timestamp: 4, disabled: true },
    ] as any);

    expect(steps).toEqual([
      { id: 'u', role: 'user', text: 'Question', timestamp: 1 },
      { id: 'a', role: 'assistant', text: 'Working', timestamp: 2 },
      {
        id: 'a-tool-call',
        role: 'tool',
        text: 'search_files',
        timestamp: 2,
        toolName: 'search_files',
        toolKind: 'call',
      },
      {
        id: 't',
        role: 'tool',
        text: 'Result',
        timestamp: 3,
        toolName: 'search_files',
        toolKind: 'result',
      },
    ]);
  });
});
