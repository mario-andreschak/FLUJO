/** @jest-environment jsdom */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const generateFlowMock = jest.fn();
const improveFlowMock = jest.fn();
const startVisualGenerationMock = jest.fn();
const loadModelsMock = jest.fn();
const synthesizeFlowGeneratorMock = jest.fn();
const createConversationMock = jest.fn();
const completeFlowGeneratorTurnMock = jest.fn();
const restoreFlowGeneratorMock = jest.fn();
let mockStorageValue: any = {
  settings: {},
  settingsHydrated: true,
};

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    generateFlow: (...args: unknown[]) => generateFlowMock(...args),
    improveFlow: (...args: unknown[]) => improveFlowMock(...args),
  },
}));

jest.mock('@/frontend/services/flow/visualGeneration', () => ({
  startVisualGeneration: (...args: unknown[]) => startVisualGenerationMock(...args),
}));

jest.mock('@/frontend/services/model', () => ({
  modelService: {
    loadModels: (...args: unknown[]) => loadModelsMock(...args),
  },
}));

jest.mock('@/frontend/services/chat', () => ({
  chatService: {
    synthesizeFlowGenerator: (...args: unknown[]) => synthesizeFlowGeneratorMock(...args),
    createConversation: (...args: unknown[]) => createConversationMock(...args),
    completeFlowGeneratorTurn: (...args: unknown[]) => completeFlowGeneratorTurnMock(...args),
    restoreFlowGenerator: (...args: unknown[]) => restoreFlowGeneratorMock(...args),
  },
}));

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => mockStorageValue,
}));

jest.mock('@/frontend/components/Chat/ChatInput', () => ({
  __esModule: true,
  default: ({ onSendMessage, disabled, placeholder }: {
    onSendMessage: (content: string) => void;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <>
      <span>{placeholder}</span>
      <button disabled={disabled} onClick={() => onSendMessage('Build the requested flow')}>
        Send request
      </button>
    </>
  ),
}));

jest.mock('@/frontend/components/Chat/ChatMessages', () => ({
  __esModule: true,
  default: ({ messages }: { messages: Array<{ content: string }> }) => (
    <div>{messages.map((entry) => entry.content).join('\n')}</div>
  ),
}));

import GenerateFlowDialog from '@/frontend/components/Flow/FlowManager/GenerateFlowDialog';

const validation = {
  issues: [],
  errorCount: 0,
  warningCount: 0,
  isRunnable: true,
};
const child = { id: 'child-1', name: 'Child', nodes: [], edges: [] };
const root = {
  id: 'root-1',
  name: 'Draft',
  nodes: [{ id: 'node-1', type: 'start', position: { x: 0, y: 0 }, data: {} }],
  edges: [],
};
const revisedRoot = { ...root, name: 'Revised draft' };
const visualAgent = {
  id: root.id,
  name: root.name,
  goal: 'Build the requested flow',
  depth: 0,
  steps: [{
    id: 'write',
    label: 'Write answer',
    task: 'Build the requested flow',
    tools: [],
    connectedAgentIds: [],
  }],
  status: 'ready' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStorageValue = {
    settings: {},
    settingsHydrated: true,
  };
  loadModelsMock.mockResolvedValue([
    { id: 'model-1', name: 'gpt', displayName: 'Generator' },
  ]);
  generateFlowMock.mockResolvedValue({
    success: true,
    flow: root,
    validation,
    flows: [{ flow: child, validation }, { flow: root, validation }],
    rootFlowId: root.id,
    attempts: 1,
    installedServers: [],
  });
  startVisualGenerationMock.mockImplementation(async (
    _input: unknown,
    onEvent: (event: Record<string, unknown>) => void | Promise<void>,
  ) => {
    await onEvent({ type: 'session-started', sessionId: 'visual-1', maxDepth: 8, message: 'Starting' });
    await onEvent({ type: 'agent-created', agent: visualAgent });
    return {
      flow: root,
      validation,
      flows: [child, root],
      rootFlowId: root.id,
      attempts: 1,
      installedServers: [],
    };
  });
  improveFlowMock.mockResolvedValue({
    success: true,
    flow: revisedRoot,
    validation,
    flows: [{ flow: child, validation }, { flow: revisedRoot, validation }],
    rootFlowId: revisedRoot.id,
    attempts: 1,
    installedServers: [],
  });
  synthesizeFlowGeneratorMock.mockResolvedValue({
    conversationId: 'conversation-1',
    flow: {
      id: 'quickchat-flow-generator-conversation-1',
      name: 'Experimental Flow Generator Session',
      nodes: [],
      edges: [],
    },
  });
  createConversationMock.mockResolvedValue(undefined);
  restoreFlowGeneratorMock.mockResolvedValue({ flow: root });
});

describe('GenerateFlowDialog generation contract', () => {
  it('always generates on the first message, then AI-improves the current draft', async () => {
    const onGenerated = jest.fn();
    render(
      <GenerateFlowDialog open onClose={() => undefined} onGenerated={onGenerated} />
    );

    expect(screen.getByText('Create an agent')).toBeInTheDocument();
    expect(screen.getByText('What should your agent help with?')).toBeInTheDocument();
    expect(screen.getByText('Describe the helper you want…')).toBeInTheDocument();
    const advancedOptions = screen.getByText('Advanced options');
    expect(advancedOptions.closest('details')).not.toHaveAttribute('open');

    const send = await screen.findByRole('button', { name: 'Send request' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    await waitFor(() => expect(startVisualGenerationMock).toHaveBeenCalledWith(
      {
        description: 'Build the requested flow',
        modelId: 'model-1',
        allowInstall: false,
        maxDepth: 8,
      },
      expect.any(Function),
      expect.anything(),
    ));
    expect(generateFlowMock).not.toHaveBeenCalled();
    expect(improveFlowMock).not.toHaveBeenCalled();
    expect((await screen.findAllByText('Draft')).length).toBeGreaterThan(0);
    expect(screen.getByText('Write answer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(improveFlowMock).toHaveBeenCalledWith(
      root,
      'Build the requested flow',
      'model-1',
      {
        allowInstall: false,
        relatedFlows: [child],
      }
    ));
    expect(startVisualGenerationMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Continue to simple builder' }));
    expect(onGenerated).toHaveBeenCalledWith(expect.objectContaining({
      flow: revisedRoot,
      flows: [child, revisedRoot],
      rootFlowId: revisedRoot.id,
      attempts: 2,
    }));
  });

  it('keeps MCP installation off until the user explicitly opts in', async () => {
    render(
      <GenerateFlowDialog open onClose={() => undefined} onGenerated={() => undefined} />
    );
    const advancedOptions = screen.getByText('Advanced options');
    fireEvent.click(advancedOptions);
    expect(advancedOptions.closest('details')).toHaveAttribute('open');
    const depth = screen.getByRole('slider', { name: 'Maximum helper nesting' });
    expect(depth).toHaveAttribute('aria-valuemin', '1');
    expect(depth).toHaveAttribute('aria-valuemax', '8');
    expect(depth).toHaveAttribute('aria-valuenow', '8');
    const consent = await screen.findByRole('checkbox', {
      name: 'Allow adding new connected tools',
    });
    expect(consent).not.toBeChecked();
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => expect(startVisualGenerationMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowInstall: true, maxDepth: 8 }),
      expect.any(Function),
      expect.anything(),
    ));
  });

  it('runs entirely through the multi-stage system Flow when the experimental setting is active', async () => {
    mockStorageValue = {
      settings: {
        experimental: {
          enabled: true,
          flowBasedGenerator: true,
        },
      },
      settingsHydrated: true,
    };
    const toolDraft = {
      flow: root,
      flows: [child, root],
      rootFlowId: root.id,
      validation,
    };
    completeFlowGeneratorTurnMock.mockImplementation(async (payload: {
      messages: Array<Record<string, unknown>>;
    }) => ({
      messages: [
        ...payload.messages,
        {
          role: 'tool',
          content: JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify(toolDraft) }],
          }),
        },
        { role: 'assistant', content: 'Draft compiled and validated.' },
      ],
    }));
    const onGenerated = jest.fn();
    render(
      <GenerateFlowDialog open onClose={() => undefined} onGenerated={onGenerated} />
    );

    expect(await screen.findByText('Experimental · Flow-based')).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Restore the bundled experimental Generation Flow',
    })).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send request' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    await waitFor(() => expect(synthesizeFlowGeneratorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'model-1',
        allowInstall: false,
      })
    ));
    expect(generateFlowMock).not.toHaveBeenCalled();
    expect(startVisualGenerationMock).not.toHaveBeenCalled();
    expect(improveFlowMock).not.toHaveBeenCalled();
    await waitFor(() => expect(completeFlowGeneratorTurnMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Continue to simple builder' }));
    expect(onGenerated).toHaveBeenCalledWith(expect.objectContaining({
      flow: root,
      flows: [child, root],
      rootFlowId: root.id,
    }));
  });
});
