import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

import ProcessNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal';
import useModelManagement from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useModelManagement';
import useServerConnection from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useServerConnection';
import useHandoffTools from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useHandoffTools';
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useModelManagement', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useServerConnection', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useHandoffTools', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('@/frontend/services/mcp', () => ({
  mcpService: {
    listServerResources: jest.fn().mockResolvedValue({ resources: [], resourceTemplates: [] }),
  },
}));

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/NodeConfiguration', () => () => <div>Basic configuration</div>);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/ModelBinding', () => () => <div>Model binding</div>);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/PromptIOControls', () => () => <div>Input and output controls</div>);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/NodeProperties', () => () => <div>Advanced properties</div>);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/shared/CaptureFields', () => () => <div>Capture fields</div>);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools/ServerResources', () => () => <div>Server resources</div>);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools/WiredResources', () => () => <div>Wired resources</div>);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools/AgentTools', () => () => <div>Connected-node tools</div>);

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/PromptTemplateEditor', () => {
  const ReactImpl = require('react') as typeof React;
  const MockPromptTemplateEditor = ReactImpl.forwardRef((_props, ref) => {
    const [insertedText, setInsertedText] = ReactImpl.useState('');
    ReactImpl.useImperativeHandle(ref, () => ({
      insertText: (text: string) => setInsertedText((current) => current + text),
      getMode: () => 'raw',
    }));
    return <div data-testid="prompt-editor">{insertedText}</div>;
  });
  MockPromptTemplateEditor.displayName = 'MockPromptTemplateEditor';
  return { __esModule: true, default: MockPromptTemplateEditor };
});

const mockUseModelManagement = useModelManagement as jest.MockedFunction<typeof useModelManagement>;
const mockUseServerConnection = useServerConnection as jest.MockedFunction<typeof useServerConnection>;
const mockUseHandoffTools = useHandoffTools as jest.MockedFunction<typeof useHandoffTools>;

const longDescription = 'Summarizes a large body of text into a concise result while preserving the most important details.';
const processNode = (id: string, properties: Record<string, unknown> = {}) => ({
  id,
  type: 'process',
  position: { x: 0, y: 0 },
  data: {
    label: `Process ${id}`,
    type: 'process',
    properties: { promptTemplate: '', ...properties },
  },
}) as any;

const baseProps = {
  open: true,
  node: processNode('one'),
  onClose: jest.fn(),
  onSave: jest.fn(),
  flowEdges: [],
  flowNodes: [],
};

const renderModal = (props: Partial<React.ComponentProps<typeof ProcessNodePropertiesModal>> = {}) =>
  render(<ProcessNodePropertiesModal {...baseProps} {...props} />);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: jest.fn(),
  });
  class MockIntersectionObserver {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
    takeRecords = jest.fn(() => []);
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: MockIntersectionObserver,
  });
});

beforeEach(() => {
  window.localStorage.clear();
  jest.clearAllMocks();
  mockUseModelManagement.mockReturnValue({
    models: [],
    isLoadingModels: false,
    loadError: null,
    handleModelSelect: jest.fn(),
    handleUnbindModel: jest.fn(),
  } as any);
  mockUseServerConnection.mockReturnValue({
    connectedMcpNodes: [{
      nodeId: 'mcp-one',
      serverName: 'server-one',
      status: 'connected',
      enabledTools: ['summarize'],
    }],
    allServers: [],
    isLoadingServers: false,
    selectedToolServerNodeId: 'mcp-one',
    serverToolsMap: {
      'server-one': [{
        name: 'summarize',
        description: longDescription,
        inputSchema: {
          type: 'object',
          properties: { topic: { type: 'string', description: 'Text to summarize' } },
          required: ['topic'],
        },
      }],
    },
    serverStatuses: { 'server-one': 'connected' },
    isLoadingTools: { 'server-one': false },
    handleSelectToolServer: jest.fn(),
    isLoadingSelectedServerTools: false,
    handleRetryServer: jest.fn(),
    handleRestartServer: jest.fn(),
  } as any);
  mockUseHandoffTools.mockReturnValue({
    handoffTools: [],
    isLoadingHandoffTools: false,
  } as any);
});

describe('ProcessNodePropertiesModal issue #320 interactions', () => {
  it('opens edits on Task, creates on Basic, and resets when the target session changes', async () => {
    const { rerender } = renderModal({ mode: 'edit' });

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Task' })).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(screen.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');

    rerender(<ProcessNodePropertiesModal {...baseProps} node={processNode('two')} mode="create" />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Basic' })).toHaveAttribute('aria-selected', 'true'));

    fireEvent.click(screen.getByRole('tab', { name: 'Connected nodes' }));
    expect(screen.getByRole('tab', { name: 'Connected nodes' })).toHaveAttribute('aria-selected', 'true');
    rerender(<ProcessNodePropertiesModal {...baseProps} node={processNode('three')} mode="edit" />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Task' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('tab', { name: 'MCP' })).toHaveAttribute('aria-selected', 'true');
  });

  it('orders Task tabs as MCP, Connected nodes, Resources and keeps the prompt editor mounted', () => {
    renderModal({ mode: 'edit' });
    const taskTabs = within(screen.getByRole('tablist', { name: 'Task tools' })).getAllByRole('tab');
    expect(taskTabs.map((tab) => tab.textContent)).toEqual(['MCP', 'Connected nodes', 'Resources']);

    const editor = screen.getByTestId('prompt-editor');
    fireEvent.click(screen.getByRole('tab', { name: 'Connected nodes' }));
    expect(screen.getByTestId('prompt-editor')).toBe(editor);
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
    expect(screen.getByTestId('prompt-editor')).toBe(editor);
  });

  it('owns separate tools/editor scroll regions and resizes the splitter within persisted bounds', async () => {
    window.localStorage.setItem('flujo.processNode.taskToolsPaneWidth', '500');
    renderModal({ mode: 'edit' });

    expect(screen.getByTestId('process-task-tools-scroll')).toHaveStyle({ overflow: 'auto' });
    expect(screen.getByTestId('process-task-editor-scroll')).toHaveStyle({ overflow: 'auto' });

    const splitContainer = screen.getByTestId('process-task-split-container');
    jest.spyOn(splitContainer, 'getBoundingClientRect').mockReturnValue({
      width: 1000,
      height: 600,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const divider = screen.getByRole('separator', { name: 'Resize Task tools and prompt editor panes' });
    expect(divider).toHaveAttribute('aria-valuenow', '500');

    fireEvent.keyDown(divider, { key: 'Home' });
    expect(divider).toHaveAttribute('aria-valuenow', '260');
    fireEvent.keyDown(divider, { key: 'End' });
    expect(divider).toHaveAttribute('aria-valuenow', '628');

    fireEvent(divider, new MouseEvent('pointerdown', { bubbles: true, clientX: 628 }));
    fireEvent(window, new MouseEvent('pointermove', { bubbles: true, clientX: 420 }));
    fireEvent(window, new MouseEvent('pointerup', { bubbles: true }));
    expect(divider).toHaveAttribute('aria-valuenow', '420');
    await waitFor(() => expect(window.localStorage.getItem('flujo.processNode.taskToolsPaneWidth')).toBe('420'));
  });

  it('stacks full-width editor and tools panes on mobile, with the editor first', () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width:899.95px'),
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
    try {
      renderModal({ mode: 'edit' });

      expect(screen.getByTestId('process-task-split-container')).toHaveStyle({
        flexDirection: 'column',
        overflow: 'visible',
      });
      expect(screen.getByTestId('process-task-editor-scroll')).toHaveStyle({
        order: '1',
        width: '100%',
      });
      expect(screen.getByTestId('process-task-tools-pane')).toHaveStyle({
        order: '2',
        width: '100%',
      });
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: previousMatchMedia });
    }
  });

  it('shows compact MCP cards with tooltip and expandable details', async () => {
    renderModal({ mode: 'edit' });

    expect(screen.getByText('1 parameter · 1 required')).toBeInTheDocument();
    expect(screen.queryByText('Parameters:')).not.toBeInTheDocument();
    const expand = screen.getByRole('button', { name: 'Expand details for summarize' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');

    fireEvent.mouseOver(screen.getByText(longDescription));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(longDescription);

    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: 'Collapse details for summarize' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Parameters:')).toBeInTheDocument();
    expect(screen.getByText(/topic/)).toBeInTheDocument();
  });

  it('retains tool binding insertion after switching Task tabs', () => {
    renderModal({ mode: 'edit' });
    const editor = screen.getByTestId('prompt-editor');

    fireEvent.click(screen.getByRole('tab', { name: 'Connected nodes' }));
    fireEvent.click(screen.getByRole('tab', { name: 'MCP' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add summarize from server-one to the prompt' }));

    expect(screen.getByTestId('prompt-editor')).toBe(editor);
    expect(editor).toHaveTextContent('${tool:server-one__summarize}');
  });
});

describe('ProcessNodePropertiesModal Persona abilities', () => {
  it('shows every native ability in plain language and saves the full preset', async () => {
    const onSave = jest.fn();
    renderModal({
      node: processNode('persona-core', {
        personaTools: ['recall', 'work_item_create'],
      }),
      onSave,
    });

    const friendlyAbilityLabels = [
      'Use existing memories',
      'Suggest things to remember',
      'Suggest memory corrections',
      'Keep important memories always available',
      'Stop keeping a memory always available',
      'Forget memories',
      'Create ongoing tasks',
      'Update ongoing tasks',
      'Finish ongoing tasks',
      'Keep checklist items for later',
      'Suggest reusable improvements',
    ];
    for (const label of friendlyAbilityLabels) {
      expect(await screen.findByRole('checkbox', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('checkbox', { name: 'Use existing memories' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Create ongoing tasks' })).toBeChecked();
    expect(screen.queryByText('work_item_create')).not.toBeInTheDocument();
    expect(screen.queryByText('recall')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All abilities' }));
    expect(screen.getByRole('checkbox', { name: 'Forget memories' })).toBeChecked();
    expect(screen.getByText('Forgetting takes effect immediately.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSave).toHaveBeenCalledWith('persona-core', expect.objectContaining({
      properties: expect.objectContaining({
        personaTools: [
          'remember',
          'recall',
          'correct',
          'forget',
          'pin',
          'unpin',
          'work_item_create',
          'work_item_update',
          'work_item_complete',
          'work_item_promote_todo',
          'suggest_improvement',
        ],
      }),
    }));
  });

  it('keeps the friendly controls in Guided mode and saves an explicit Off choice', async () => {
    const onSave = jest.fn();
    renderModal({
      authoringMode: 'guided',
      node: processNode('guided-persona', { personaTools: ['remember', 'unpin'] }),
      onSave,
    });

    expect(await screen.findByText('Persona abilities')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Advanced' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][1] as { properties: Record<string, unknown> };
    expect(saved.properties).toHaveProperty('personaTools', []);
  });
});
