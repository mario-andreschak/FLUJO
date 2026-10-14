import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EventStreamHandlers } from '@/frontend/services/chat';
import { createHash } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { TextDecoder } from 'node:util';
import { readModelTurnInspection } from '@/frontend/services/chat/modelTurnInspection';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { translate } from '@/frontend/i18n/core';
import { SUPPORTED_LOCALES } from '@/frontend/i18n/locales';
import type { PendingElicitation, PendingQuestion } from '@/frontend/components/Chat/ChatMessages';

const mockLoadFlows = jest.fn();
const mockListConversations = jest.fn();
const mockGetConversation = jest.fn();
const mockCreateConversation = jest.fn();
const mockSynthesizeQuickChat = jest.fn();
const mockUpdateConversationPersonaTarget = jest.fn();
const mockGetModelTurns = jest.fn();
const mockGetModelTurnInspection = jest.fn();

async function inspectionFixture(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const records = Buffer.from(
    JSON.stringify({ kind: 'chunk', data: bytes.toString('base64') }) + '\n'
    + JSON.stringify({ kind: 'end', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) + '\n',
  );
  return readModelTurnInspection({
    body: new ReadableStream({ start(controller) { controller.enqueue(records); controller.close(); } }),
    headers: { get: () => 'json-chunks-v1' },
  } as unknown as Response);
}
const mockSubscribeToEvents = jest.fn();
const mockSubscribeToSidebarEvents = jest.fn();
const mockStartCompletion = jest.fn();
let mockInitialConversationId: string | null = 'conversation-current';
let mockPhoneLayout = false;

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('@mui/material', () => ({
  ...jest.requireActual('@mui/material'),
  useMediaQuery: () => mockPhoneLayout,
}));

jest.mock('@/utils/storage', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const StorageKey = {
    CURRENT_CONVERSATION_ID: 'current-conversation-id',
    LAST_PICKED_FLOW_ID: 'last-picked-flow-id',
  };
  return {
    StorageKey,
    useLocalStorage: (key: string, initialValue: unknown) => {
      if (!Object.values(StorageKey).includes(key)) {
        throw new Error(`Server storage received a non-enum key: ${key}`);
      }
      return React.useState(
        key === StorageKey.CURRENT_CONVERSATION_ID
          ? mockInitialConversationId
          : initialValue,
      );
    },
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
      listConversationPage: async (...args: unknown[]) => {
        const items = await mockListConversations(...args);
        return { items, total: items.length, hasMore: false };
      },
      getConversation: (...args: unknown[]) => mockGetConversation(...args),
      getModelTurns: (...args: unknown[]) => mockGetModelTurns(...args),
      getModelTurnInspection: (...args: unknown[]) => mockGetModelTurnInspection(...args),
      subscribeToSidebarEvents: (...args: unknown[]) => mockSubscribeToSidebarEvents(...args),
      subscribeToEvents: (...args: unknown[]) => mockSubscribeToEvents(...args),
      updateConversationFlow: jest.fn(),
      updateConversationApproval: jest.fn(),
      updateConversationTitle: jest.fn(),
      createConversation: (...args: unknown[]) => mockCreateConversation(...args),
      updateConversationPersonaTarget: (...args: unknown[]) => mockUpdateConversationPersonaTarget(...args),
      deleteConversation: jest.fn(),
      deleteConversations: jest.fn(),
      cancel: jest.fn(),
      injectMessage: jest.fn(),
      respondToToolCall: jest.fn(),
      debugContinue: jest.fn(),
      debugStep: jest.fn(),
      setBreakpoints: jest.fn(),
      synthesizeQuickChat: (...args: unknown[]) => mockSynthesizeQuickChat(...args),
    },
  };
});

jest.mock('openai', () => {
  class OpenAIError extends Error {}
  class APIError extends OpenAIError {}
  class OpenAI {
    chat = { completions: { create: mockStartCompletion } };
  }
  return { __esModule: true, default: OpenAI, OpenAIError, APIError };
});

jest.mock('@/frontend/components/Chat/FlowSelector', () => ({
  __esModule: true,
  default: ({ onSelectFlow }: { onSelectFlow: (id: string) => void }) => (
    <button type="button" onClick={() => onSelectFlow('flow-writing')}>Choose Writing Agent</button>
  ),
}));

jest.mock('@/frontend/components/Chat/ChatTargetSelector', () => ({
  __esModule: true,
  default: ({
    selectedPersonaId,
    selectedPersonaBehaviorSlotKey,
    onSelectFlow,
    onSelectPersona,
    fullScreenPicker,
  }: {
    selectedPersonaId?: string | null;
    selectedPersonaBehaviorSlotKey?: string | null;
    onSelectFlow: (id: string) => void;
    onSelectPersona: (id: string, behaviorSlotKey: string) => void;
    fullScreenPicker?: boolean;
  }) => (
    <div
      data-testid="target-selector"
      data-persona={selectedPersonaId ?? ''}
      data-behavior={selectedPersonaBehaviorSlotKey ?? ''}
      data-full-screen={String(Boolean(fullScreenPicker))}
    >
      <button type="button" onClick={() => onSelectFlow('flow-writing')}>Choose Writing Agent</button>
      <button type="button" onClick={() => onSelectPersona('persona-ada', 'research')}>Choose Ada Persona</button>
    </div>
  ),
}));

jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({
  MAX_MCP_APP_CONTEXT_BYTES: 1_000_000,
  jsonUtf8ByteLength: () => 0,
}));

jest.mock('@/frontend/components/Chat/ChatHistory', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/ChatMessages', () => ({
  __esModule: true,
  default: ({ messages, pendingQuestion, pendingElicitation, onAnswerQuestion, onDeclineQuestion, onSubmitElicitation, onCancelElicitation }: {
    messages?: unknown[];
    pendingQuestion?: PendingQuestion | null;
    pendingElicitation?: PendingElicitation | null;
    onAnswerQuestion: (id: string, answers: string[][]) => void;
    onDeclineQuestion: (id: string) => void;
    onSubmitElicitation: (id: string, content: Record<string, string>) => void;
    onCancelElicitation: (id: string) => void;
  }) => (
    <>
      <div data-testid="rendered-message-count">{messages?.length ?? 0}</div>
      {pendingQuestion && <>
        <button type="button" onClick={() => onAnswerQuestion(pendingQuestion.questionId, [['Retained answer']])}>Answer pending question</button>
        <button type="button" onClick={() => onDeclineQuestion(pendingQuestion.questionId)}>Decline pending question</button>
      </>}
      {pendingElicitation && <>
        <button type="button" onClick={() => onSubmitElicitation(pendingElicitation.elicitationId, { note: 'Retained form' })}>Submit pending form</button>
        <button type="button" onClick={() => onCancelElicitation(pendingElicitation.elicitationId)}>Cancel pending form</button>
      </>}
    </>
  ),
}));
jest.mock('@/frontend/components/Chat/ChatInput', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const MockChatInput = ({ disabled }: { disabled?: boolean }) => {
    const [draft, setDraft] = React.useState('');
    return (
      <div data-testid="chat-input" data-disabled={String(Boolean(disabled))}>
        <input
          aria-label="Composer draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
    );
  };
  return { __esModule: true, default: MockChatInput };
});
jest.mock('@/frontend/components/Chat/DevCanvasDock', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/LiveRunIndicator', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/TodoDock', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/ConversationStats', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Chat/QuickChatDialog', () => ({
  __esModule: true,
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) => open ? (
    <div role="dialog" aria-label="Quick chat">
      <button type="button" onClick={onClose}>Close Quick chat</button>
    </div>
  ) : null,
}));
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
    Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder, configurable: true });
    mockInitialConversationId = 'conversation-current';
    mockPhoneLayout = false;
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: jest.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: jest.fn(),
    });
    mockLoadFlows.mockReset().mockResolvedValue([
      { id: 'flow-research', name: 'Research Agent', nodes: [], edges: [] },
      { id: 'flow-writing', name: 'Writing Agent', nodes: [], edges: [] },
    ]);
    mockListConversations.mockReset().mockResolvedValue([conversationSummary]);
    mockGetConversation.mockReset().mockResolvedValue(detailedConversation);
    mockCreateConversation.mockReset();
    mockSynthesizeQuickChat.mockReset();
    mockUpdateConversationPersonaTarget.mockReset();
    mockGetModelTurns.mockReset().mockResolvedValue({ turns: [] });
    mockGetModelTurnInspection.mockReset();
    mockSubscribeToEvents.mockReset().mockImplementation(() => ({ close: jest.fn() }));
    mockSubscribeToSidebarEvents.mockReset().mockImplementation(() => ({ close: jest.fn() }));
    mockStartCompletion.mockReset();
  });

  it('recovers the viewed snapshot before reconnecting and cancels recovery on unmount', async () => {
    const running = { ...detailedConversation, status: 'running' };
    mockListConversations.mockResolvedValue([running]);
    mockGetConversation.mockResolvedValue(running);
    const { unmount } = render(<Chat />);
    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1));
    jest.useFakeTimers();
    try {
      const handlers = mockSubscribeToEvents.mock.calls[0][1] as EventStreamHandlers;
      let complete!: (value: typeof running) => void;
      mockGetConversation.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
      act(() => handlers.onReset?.({ version: 1, reason: 'replay-gap', recovery: 'reload-snapshot', nextSeq: 42 }));
      act(() => jest.advanceTimersByTime(3000));
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
      await act(async () => complete(running));
      act(() => jest.advanceTimersByTime(3000));
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(2);
      expect(mockSubscribeToEvents).toHaveBeenLastCalledWith('conversation-current', expect.objectContaining({ onReset: expect.any(Function) }), 42, { activityOnly: true });
      const current = mockSubscribeToEvents.mock.calls[1][1] as EventStreamHandlers;
      await act(async () => current.onReset?.({ version: 1, reason: 'slow-consumer', recovery: 'reload-snapshot', nextSeq: 50 }));
      unmount();
      act(() => jest.advanceTimersByTime(3000));
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(2);
      expect(mockCreateConversation).not.toHaveBeenCalled();
    } finally { unmount(); jest.useRealTimers(); }
  });
  it('keeps loading visible and preserves the composer while the Persona conversation opens', async () => {
    mockInitialConversationId = null;
    const personaConversation = {
      ...conversationSummary,
      flowId: null,
      personaId: 'persona-ada',
      messages: [],
    };
    let resolveList!: (items: typeof personaConversation[]) => void;
    let resolveDetails!: (conversation: typeof personaConversation) => void;
    mockListConversations.mockReturnValue(new Promise(resolve => { resolveList = resolve; }));
    mockGetConversation.mockReturnValue(new Promise(resolve => { resolveDetails = resolve; }));

    render(<Chat />);

    expect(screen.getByText('Loading conversations…').closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Loading chat…').closest('[role="status"]')).toHaveAttribute('aria-atomic', 'true');
    expect(screen.queryByText(/Create a new conversation to start chatting|Select a conversation or create a new one/)).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'true');
    fireEvent.change(screen.getByLabelText('Composer draft'), { target: { value: 'My first Persona question' } });

    await act(async () => { resolveList([personaConversation]); });
    await waitFor(() => expect(mockGetConversation).toHaveBeenCalled());
    expect(screen.queryByText('Loading conversations…')).not.toBeInTheDocument();
    expect(screen.getByText('Loading chat…')).toBeInTheDocument();
    expect(screen.queryByText(/Create a new conversation to start chatting|Select a conversation or create a new one/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Composer draft')).toHaveValue('My first Persona question');
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'true');

    await act(async () => { resolveDetails(personaConversation); });
    await waitFor(() => expect(screen.getByTestId('rendered-message-count')).toHaveTextContent('0'));
    expect(screen.queryByText('Loading chat…')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Composer draft')).toHaveValue('My first Persona question');
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'false');
  });

  it('shows the first-conversation guidance only after an empty list has loaded', async () => {
    mockInitialConversationId = null;
    let resolveList!: (items: unknown[]) => void;
    mockListConversations.mockReturnValue(new Promise(resolve => { resolveList = resolve; }));

    render(<Chat />);

    expect(screen.getByText('Loading chat…')).toBeInTheDocument();
    expect(screen.queryByText('Create a new conversation to start chatting.')).not.toBeInTheDocument();
    await act(async () => { resolveList([]); });
    expect(await screen.findByText('Create a new conversation to start chatting.')).toBeInTheDocument();
    expect(screen.queryByText('Loading chat…')).not.toBeInTheDocument();
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  it.each([true, false])('opens Quick chat from an empty phone with saved agents: %s', async (hasSavedAgents) => {
    mockPhoneLayout = true;
    mockInitialConversationId = null;
    mockListConversations.mockResolvedValue([]);
    if (!hasSavedAgents) mockLoadFlows.mockResolvedValue([]);
    render(<Chat />);

    const quickChat = await screen.findByRole('button', { name: 'Quick chat' });
    expect(screen.getByTestId('target-selector')).toHaveAttribute('data-full-screen', 'true');
    if (hasSavedAgents) expect(screen.getByRole('button', { name: 'New conversation' })).toBeInTheDocument();
    else expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Quick chat' })).not.toBeInTheDocument();

    fireEvent.click(quickChat);
    expect(await screen.findByRole('dialog', { name: 'Quick chat' })).toBeInTheDocument();
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockSynthesizeQuickChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close Quick chat' }));
    expect(screen.queryByRole('dialog', { name: 'Quick chat' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quick chat' })).toBeInTheDocument();
  });

  it.each([
    ['New conversation', 'flow-research'],
    ['Choose Writing Agent', 'flow-writing'],
    ['Choose Ada Persona', null],
  ] as const)('preserves %s from the empty phone', async (buttonName, flowId) => {
    mockPhoneLayout = true;
    mockInitialConversationId = null;
    mockListConversations.mockResolvedValue([]);
    if (flowId === null) mockLoadFlows.mockResolvedValue([]);
    const createdSummary = {
      ...conversationSummary,
      id: 'conversation-phone',
      flowId,
      ...(flowId === null ? { personaId: 'persona-ada', personaBehaviorSlotKey: 'research' } : {}),
    };
    mockCreateConversation.mockResolvedValue(createdSummary);
    mockGetConversation.mockResolvedValue({ ...createdSummary, messages: [] });
    render(<Chat />);

    fireEvent.click(await screen.findByRole('button', { name: buttonName }));
    await waitFor(() => expect(mockCreateConversation).toHaveBeenCalledTimes(1));
    expect(mockCreateConversation).toHaveBeenCalledWith(expect.objectContaining({
      flowId,
      ...(flowId === null ? { personaTargetId: 'persona-ada', personaBehaviorSlotKey: 'research' } : {}),
    }));
    expect(mockSynthesizeQuickChat).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Quick chat' })).not.toBeInTheDocument();
    expect(await screen.findByTestId('chat-input')).toHaveAttribute('data-disabled', 'false');
  });

  it('renders the current transcript in Live and the archived snapshot in History', async () => {
    const turns = [1, 2].map(index => ({
      id: `dispatch-${index}`,
      conversationId: conversationSummary.id,
      node: { nodeId: `node-${index}`, nodeName: `Node ${index}` },
      modelId: 'model-1',
      modelName: 'Example Model',
      adapter: 'openai',
      operation: 'chat.completions.create',
      timestamp: index * 1_000,
      outcome: 'completed' as const,
      attempt: index,
      canonicalMessageCount: index + 1,
      wireMessageCount: index + 1,
      mediaCount: 0,
      archiveVersion: 1 as const,
    }));
    const historicalMessages = [
      { id: 'system', role: 'system', content: 'Hidden system prompt', timestamp: 1 },
      { id: 'user-1', role: 'user', content: 'First question', timestamp: 2 },
      { id: 'assistant-1', role: 'assistant', content: 'First answer', timestamp: 3 },
    ];
    mockGetConversation.mockResolvedValue({
      ...detailedConversation,
      messages: [
        ...historicalMessages.slice(1),
        { id: 'user-2', role: 'user', content: 'Second question', timestamp: 4 },
        { id: 'assistant-2', role: 'assistant', content: 'Second answer', timestamp: 5 },
      ],
    });
    mockGetModelTurns.mockResolvedValue({ turns });
    mockGetModelTurnInspection.mockImplementation(async (_conversationId: string, dispatchId: string) => inspectionFixture({
      version: 1,
      entry: turns.find(turn => turn.id === dispatchId),
      canonicalMessages: dispatchId === 'dispatch-1'
        ? historicalMessages.slice(0, 2)
        : historicalMessages,
      genericWire: [],
      sdkRequest: { dispatchId },
      media: [],
    }));

    render(<Chat />);

    const chatButton = await screen.findByRole('button', { name: 'Chat' });
    expect(chatButton).toHaveAttribute('aria-pressed', 'true');
    // The newest model-turn snapshot is a pre-dispatch input and therefore
    // lacks the assistant response it produced. Live must use the current
    // conversation, which contains both completed exchanges.
    await waitFor(() => expect(screen.getByTestId('rendered-message-count')).toHaveTextContent('4'));

    fireEvent.click(screen.getByRole('option', { name: /1\. Node 1/ }));

    expect(chatButton).toHaveAttribute('aria-pressed', 'true');
    // History now pages the original canonical archive through the actual
    // inspector. The selected boundary contains one user message and no
    // assistant response; Live still renders all four current messages above.
    const archive = await screen.findByText(/First question/, { selector: 'pre' });
    expect(JSON.parse(archive.textContent ?? '[]').filter((message: { role: string }) => message.role !== 'system')).toHaveLength(1);
    expect(archive).not.toHaveTextContent('First answer');
    expect(archive).not.toHaveTextContent('Second question');

    const modelInputButton = screen.getByRole('button', { name: /Model input/i });
    fireEvent.click(modelInputButton);
    expect(modelInputButton).toHaveAttribute('aria-pressed', 'true');

    const requestDetailButton = await screen.findByRole('button', { name: 'Request Detail' });
    fireEvent.click(requestDetailButton);
    expect(requestDetailButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('model-turn-inspector-header')).toHaveStyle({ position: 'sticky' });

    fireEvent.click(screen.getByRole('option', { name: /2\. Node 2/ }));

    expect(modelInputButton).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Request Detail' })).toHaveAttribute('aria-pressed', 'true');
    });
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

  it('creates a distinct Persona conversation from a fresh Flow draft and preserves composer text', async () => {
    const freshConversation = {
      id: 'conversation-current',
      title: 'Fresh Flow draft',
      flowId: 'flow-research',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const createdSummary = {
      id: 'conversation-persona',
      title: 'New conversation',
      flowId: null,
      personaId: 'persona-ada',
      personaBehaviorSlotKey: 'research',
      createdAt: 3,
      updatedAt: 3,
    };
    mockListConversations.mockResolvedValueOnce([freshConversation]);
    mockGetConversation.mockImplementation(async (id: string) => (
      id === createdSummary.id ? { ...createdSummary, messages: [] } : freshConversation
    ));
    mockCreateConversation.mockResolvedValue(createdSummary);

    render(<Chat />);

    await waitFor(() => expect(screen.getByTestId('rendered-message-count')).toHaveTextContent('0'));
    fireEvent.change(screen.getByLabelText('Composer draft'), { target: { value: 'Keep this thought' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose Ada Persona' }));

    await waitFor(() => expect(mockCreateConversation).toHaveBeenCalledTimes(1));
    expect(mockCreateConversation).toHaveBeenCalledWith(expect.objectContaining({
      flowId: null,
      personaTargetId: 'persona-ada',
      personaBehaviorSlotKey: 'research',
    }));
    expect(mockUpdateConversationPersonaTarget).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('target-selector')).toHaveAttribute('data-persona', 'persona-ada'));
    expect(screen.getByTestId('target-selector')).toHaveAttribute('data-behavior', 'research');
    expect(screen.getByLabelText('Composer draft')).toHaveValue('Keep this thought');
  });

  it('keeps the original Flow draft selected when Persona creation fails', async () => {
    const freshConversation = {
      id: 'conversation-current',
      title: 'Fresh Flow draft',
      flowId: 'flow-research',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    mockListConversations.mockResolvedValueOnce([freshConversation]);
    mockGetConversation.mockResolvedValue(freshConversation);
    mockCreateConversation.mockRejectedValue(new Error('creation rejected'));

    render(<Chat />);

    await waitFor(() => expect(screen.getByTestId('rendered-message-count')).toHaveTextContent('0'));
    fireEvent.change(screen.getByLabelText('Composer draft'), { target: { value: 'Do not lose this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose Ada Persona' }));

    expect(await screen.findByText(/creation rejected/)).toBeInTheDocument();
    expect(screen.getByTestId('target-selector')).toHaveAttribute('data-persona', '');
    expect(screen.getByLabelText('Composer draft')).toHaveValue('Do not lose this');
    expect(mockUpdateConversationPersonaTarget).not.toHaveBeenCalled();
  });

  it('coalesces repeated Persona selection while creation is pending', async () => {
    const freshConversation = {
      id: 'conversation-current',
      title: 'Fresh Flow draft',
      flowId: 'flow-research',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const createdSummary = {
      id: 'conversation-persona',
      title: 'New conversation',
      flowId: null,
      personaId: 'persona-ada',
      personaBehaviorSlotKey: 'research',
      createdAt: 3,
      updatedAt: 3,
    };
    let resolveCreate!: (value: typeof createdSummary) => void;
    mockListConversations.mockResolvedValueOnce([freshConversation]);
    mockGetConversation.mockImplementation(async (id: string) => (
      id === createdSummary.id ? { ...createdSummary, messages: [] } : freshConversation
    ));
    mockCreateConversation.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));

    render(<Chat />);

    await waitFor(() => expect(screen.getByTestId('rendered-message-count')).toHaveTextContent('0'));
    const personaButton = screen.getByRole('button', { name: 'Choose Ada Persona' });
    fireEvent.click(personaButton);
    fireEvent.click(personaButton);
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);

    resolveCreate(createdSummary);
    await waitFor(() => expect(screen.getByTestId('target-selector')).toHaveAttribute('data-persona', 'persona-ada'));
  });

  it('keeps the composer enabled for a Persona draft without a Flow id', async () => {
    const personaConversation = {
      id: 'conversation-current',
      title: 'Ask Ada',
      flowId: null,
      personaId: 'persona-ada',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    mockListConversations.mockResolvedValueOnce([personaConversation]);
    mockGetConversation.mockResolvedValueOnce(personaConversation);

    render(<Chat />);

    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'false'));
  });

  const pendingConversation = {
    ...detailedConversation, status: 'running', flowId: null, personaId: 'persona-ada',
    pendingInputs: { nextSeq: 1,
      questions: [{ questionId: 'pending-question', createdAt: 1, questions: [{ prompt: 'Choose', options: ['Retained answer'] }] }],
      elicitations: [{ elicitationId: 'pending-form', createdAt: 1, message: 'Review', requestedSchema: { properties: { note: { type: 'string' } } } }],
    },
  };

  it.each(SUPPORTED_LOCALES.map(({ code }) => code))('localizes a failed Persona input in %s without offering a new run', async locale => {
    const originalFetch = globalThis.fetch;
    const response = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Raw English validation error' }) }));
    globalThis.fetch = response as unknown as typeof fetch;
    localStorage.setItem('flujo.locale', locale);
    mockListConversations.mockResolvedValue([pendingConversation]);
    mockGetConversation.mockResolvedValue(pendingConversation);
    const view = render(<I18nProvider><Chat /></I18nProvider>);
    try {
      const answer = await screen.findByRole('button', { name: 'Answer pending question' });
      if (locale === 'en') {
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
        const handlers = mockSubscribeToEvents.mock.calls[0][1] as EventStreamHandlers;
        act(() => handlers.onEvent({ type: 'error', conversationId: 'conversation-current', seq: 1, timestamp: 1,
          message: 'Previous run failure', error: { message: 'Previous normalized failure', code: 'PREVIOUS' } }));
        expect(screen.getByText('Previous normalized failure')).toBeInTheDocument();
      }
      fireEvent.click(answer);
      const guidance = translate(locale, 'chat.page.inputResponseFailed');
      expect(await screen.findByText(guidance)).toBeInTheDocument();
      expect(within(screen.getByRole('alert')).queryByRole('button', { name: translate(locale, 'chat.page.retry') })).not.toBeInTheDocument();
      expect(screen.queryByText('Raw English validation error')).not.toBeInTheDocument();
      expect(screen.queryByText('Previous normalized failure')).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveAttribute('aria-atomic', 'true');
      expect(screen.getByRole('button', { name: 'Answer pending question' })).toBeInTheDocument();
      const detailReads = mockGetConversation.mock.calls.length;
      const nextLocale = locale === 'de' ? 'es' : 'de';
      fireEvent(window, new StorageEvent('storage', { key: 'flujo.locale', newValue: nextLocale }));
      expect(await screen.findByText(translate(nextLocale, 'chat.page.inputResponseFailed'))).toBeInTheDocument();
      expect(mockGetConversation).toHaveBeenCalledTimes(detailReads);
      expect(mockCreateConversation).not.toHaveBeenCalled();
      expect(mockStartCompletion).not.toHaveBeenCalled();
    } finally { view.unmount(); globalThis.fetch = originalFetch; localStorage.clear(); }
  });

  it.each([
    ['Answer pending question', 'question-answer', { questionId: 'pending-question', answers: [['Retained answer']] }, 'chat.page.inputResponseFailed'],
    ['Decline pending question', 'question-decline', { questionId: 'pending-question' }, 'chat.page.inputDeclineFailed'],
    ['Submit pending form', 'elicitation-submit', { elicitationId: 'pending-form', content: { note: 'Retained form' } }, 'chat.page.inputSubmitFailed'],
    ['Cancel pending form', 'elicitation-cancel', { elicitationId: 'pending-form' }, 'chat.page.inputCancelFailed'],
  ] as const)('retries %s through the current mailbox and clears the failure after success', async (name, action, payload, errorKey) => {
    const originalFetch = globalThis.fetch;
    let succeed = false;
    const responses: unknown[] = [];
    globalThis.fetch = jest.fn(async (url, init) => {
      if (String(url).includes('/respond')) responses.push(JSON.parse(String(init?.body)));
      return { ok: succeed, status: succeed ? 200 : 404, json: async () => ({ error: 'Stale input' }) } as Response;
    });
    mockListConversations.mockResolvedValue([pendingConversation]);
    mockGetConversation.mockResolvedValue(pendingConversation);
    const view = render(<Chat />);
    try {
      const control = await screen.findByRole('button', { name: String(name) });
      fireEvent.click(control);
      expect(await screen.findByText(translate('en', errorKey))).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      succeed = true;
      const empty = { ...pendingConversation, pendingInputs: { nextSeq: 2, questions: [], elicitations: [] } };
      mockGetConversation.mockResolvedValue(empty);
      fireEvent.click(screen.getByRole('button', { name: String(name) }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByRole('button', { name: String(name) })).not.toBeInTheDocument());
      expect(responses).toEqual([{ action, ...payload as object }, { action, ...payload as object }]);
      expect(mockCreateConversation).not.toHaveBeenCalled();
      expect(mockStartCompletion).not.toHaveBeenCalled();
    } finally { view.unmount(); globalThis.fetch = originalFetch; }
  });

  it.each(['network', 'non-json'])('handles a %s response failure with usable guidance', async failure => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => {
      if (failure === 'network') throw new TypeError('Failed to fetch');
      return { ok: false, status: 503, json: async () => { throw new SyntaxError('HTML response'); } } as unknown as Response;
    });
    mockListConversations.mockResolvedValue([pendingConversation]);
    mockGetConversation.mockResolvedValue(pendingConversation);
    const view = render(<Chat />);
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Answer pending question' }));
      expect(await screen.findByText(translate('en', 'chat.page.inputResponseFailed'))).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Answer pending question' })).toBeInTheDocument();
    } finally { view.unmount(); globalThis.fetch = originalFetch; }
  });

  it('exposes a fresh live alert for identical failures batched with their clear', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'Same failed response' }) } as Response));
    mockListConversations.mockResolvedValue([pendingConversation]);
    mockGetConversation.mockResolvedValue(pendingConversation);
    const view = render(<Chat />);
    try {
      const control = await screen.findByRole('button', { name: 'Answer pending question' });
      control.focus();
      await act(async () => { fireEvent.click(control); });
      const first = screen.getByRole('alert');
      await act(async () => { fireEvent.click(control); });
      expect(screen.getByRole('alert')).not.toBe(first);
      expect(screen.getByRole('alert')).toHaveTextContent(translate('en', 'chat.page.inputResponseFailed'));
      expect(document.activeElement).toBe(control);
      expect(mockStartCompletion).not.toHaveBeenCalled();
    } finally { view.unmount(); globalThis.fetch = originalFetch; }
  });
});
