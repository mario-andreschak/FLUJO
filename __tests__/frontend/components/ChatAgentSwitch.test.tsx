import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockLoadFlows = jest.fn();
const mockListConversations = jest.fn();
const mockGetConversation = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('@mui/material', () => ({
  ...jest.requireActual('@mui/material'),
  useMediaQuery: () => false,
}));

jest.mock('@/utils/storage', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const StorageKey = {
    CURRENT_CONVERSATION_ID: 'current-conversation-id',
    LAST_PICKED_FLOW_ID: 'last-picked-flow-id',
  };
  return {
    StorageKey,
    useLocalStorage: (key: string, initialValue: unknown) => React.useState(
      key.startsWith(`${StorageKey.CURRENT_CONVERSATION_ID}:`)
        ? 'conversation-current'
        : initialValue,
    ),
  };
});

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    loadFlows: (...args: unknown[]) => mockLoadFlows(...args),
    getFlow: jest.fn(),
  },
}));

jest.mock('@/frontend/services/chat', () => {
  class ChatApiError extends Error {
    status = 500;
  }
  return {
    ChatApiError,
    chatService: {
      listConversations: (...args: unknown[]) => mockListConversations(...args),
      getConversation: (...args: unknown[]) => mockGetConversation(...args),
      subscribeToSidebarEvents: jest.fn(() => ({ close: jest.fn() })),
      subscribeToEvents: jest.fn(() => ({ close: jest.fn() })),
      updateConversationFlow: jest.fn(),
      updateConversationApproval: jest.fn(),
      updateConversationTitle: jest.fn(),
      createConversation: jest.fn(),
      deleteConversation: jest.fn(),
      deleteConversations: jest.fn(),
      cancel: jest.fn(),
      injectMessage: jest.fn(),
      respondToToolCall: jest.fn(),
      debugContinue: jest.fn(),
      debugStep: jest.fn(),
      setBreakpoints: jest.fn(),
      synthesizeQuickChat: jest.fn(),
    },
  };
});

jest.mock('openai', () => {
  class OpenAIError extends Error {}
  class APIError extends OpenAIError {}
  class OpenAI {
    chat = { completions: { create: jest.fn() } };
  }
  return { __esModule: true, default: OpenAI, OpenAIError, APIError };
});

jest.mock('@/frontend/components/Chat/FlowSelector', () => ({
  __esModule: true,
  default: ({ onSelectFlow }: { onSelectFlow: (id: string) => void }) => (
    <button type="button" onClick={() => onSelectFlow('flow-writing')}>Choose Writing Agent</button>
  ),
}));

jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({
  MAX_MCP_APP_CONTEXT_BYTES: 1_000_000,
  jsonUtf8ByteLength: () => 0,
}));

jest.mock('@/frontend/components/Chat/ChatHistory', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/ChatMessages', () => ({
  __esModule: true,
  default: ({ messages }: { messages?: unknown[] }) => (
    <div data-testid="rendered-message-count">{messages?.length ?? 0}</div>
  ),
}));
jest.mock('@/frontend/components/Chat/ChatInput', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/DevCanvasDock', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/LiveRunIndicator', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/TodoDock', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/ConversationStats', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/QuickChatDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/DebuggerCanvas', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/ExecutedFlowPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/shared/Spinner', () => ({ __esModule: true, default: () => null }));
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: () => ({
    open: false,
    openDock: jest.fn(),
    closeDock: jest.fn(),
    toggleDock: jest.fn(),
    getPageContext: jest.fn(),
    applyPageAction: jest.fn(),
    registerPage: jest.fn(() => jest.fn()),
  }),
  useAskFlujoPage: jest.fn(() => null),
}));

import Chat from '@/frontend/components/Chat';

const conversationSummary = {
  id: 'conversation-current',
  title: 'Draft a launch',
  flowId: 'flow-research',
  createdAt: 1,
  updatedAt: 2,
  lastUserMessageAt: 2,
  status: 'completed',
};

const detailedConversation = {
  ...conversationSummary,
  messages: [
    { id: 'message-user', role: 'user', content: 'Help me plan it', timestamp: 1 },
  ],
};

describe('Talk conversation Agent switch terminology', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: jest.fn(),
    });
    mockLoadFlows.mockReset().mockResolvedValue([
      { id: 'flow-research', name: 'Research Agent', nodes: [], edges: [] },
      { id: 'flow-writing', name: 'Writing Agent', nodes: [], edges: [] },
    ]);
    mockListConversations.mockReset().mockResolvedValue([conversationSummary]);
    mockGetConversation.mockReset().mockResolvedValue(detailedConversation);
  });

  it('confirms switching an active conversation to another Agent', async () => {
    render(<Chat />);

    await waitFor(() => expect(screen.getByTestId('rendered-message-count')).toHaveTextContent('1'));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Writing Agent' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Switch agent?' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('current agent');
    expect(dialog).toHaveTextContent('Writing Agent');
    expect(dialog).toHaveTextContent('that agent’s starting point');
    expect(within(dialog).getByRole('button', { name: 'Switch agent' })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/\bflow\b/i);
  });
});
