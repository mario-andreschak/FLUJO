import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InspectorPanel } from '@/frontend/components/Flow/FlowManager/FlowBuilder/InspectorPanel';

jest.mock('@/frontend/components/mcp/MCPServerManager/ServerCard', () => ({
  __esModule: true,
  default: ({ name, onClick }: { name: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{name}</button>
  ),
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

jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => ({ toggleTheme: jest.fn(), isDarkMode: false, visualStyle: 'modern', livingWorldEnabled: false, themeHydrated: true, setVisualStyle: jest.fn(), setLivingWorldEnabled: jest.fn(), setThemePreset: jest.fn() }),
}));

const processNode: any = {
  id: 'process-1',
  type: 'process',
  position: { x: 100, y: 200 },
  selected: true,
  data: {
    type: 'process',
    label: 'Research',
    description: 'Gather facts',
    properties: {
      promptTemplate: 'Find reliable sources',
      modelId: 'model-1',
    },
  },
};

const baseProps = {
  onClearSelection: jest.fn(),
  onCommitNode: jest.fn(),
  onOpenAdvanced: jest.fn(),
  flowName: 'research_flow',
  flowNameError: null,
  onFlowNameChange: jest.fn(),
  flowDescription: 'Research workflow',
  onFlowDescriptionChange: jest.fn(),
  authoringMode: 'guided' as const,
  onAuthoringModeChange: jest.fn(),
  permissionRuleCount: 0,
  onOpenPermissionRules: jest.fn(),
};

describe('FlowBuilder InspectorPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows selected node essentials inline and commits a buffered edit on blur', () => {
    render(<InspectorPanel {...baseProps} selectedNode={processNode} />);

    expect(screen.getByRole('tab', { name: 'Node' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByDisplayValue('Find reliable sources')).toBeInTheDocument();
    // The connected model is shown once, by the dedicated model binding, so the
    // generic summary must not repeat it as a "Model" row.
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
    expect(screen.queryByText('model-1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('What this step does')).not.toBeInTheDocument();

    const name = screen.getByLabelText('Node name');
    fireEvent.change(name, { target: { value: 'Research deeply' } });
    fireEvent.blur(name);

    expect(baseProps.onCommitNode).toHaveBeenCalledWith(
      'process-1',
      expect.objectContaining({ label: 'Research deeply' }),
    );
  });

  it('keeps complex configuration available without making it the default path', () => {
    render(<InspectorPanel {...baseProps} selectedNode={processNode} />);

    fireEvent.change(screen.getByLabelText('Node name'), { target: { value: 'Fresh inline name' } });
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Use the fresh prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /Full settings/i }));

    expect(baseProps.onOpenAdvanced).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        label: 'Fresh inline name',
        properties: expect.objectContaining({ promptTemplate: 'Use the fresh prompt' }),
      }),
    }));
  });

  it('places Full settings above the connected AI section and shows the model only once', () => {
    const models: any[] = [{
      id: 'model-1',
      name: 'bound-model',
      displayName: 'Bound Model',
      provider: 'openai',
      ApiKey: 'encrypted',
    }];
    const boundNode: any = {
      ...processNode,
      data: {
        ...processNode.data,
        properties: { ...processNode.data.properties, boundModel: 'model-1' },
      },
    };

    render(<InspectorPanel {...baseProps} selectedNode={boundNode} models={models} />);

    const fullSettings = screen.getByRole('button', { name: /Full settings/i });
    const connectedAi = screen.getByText('Connected AI');
    expect(fullSettings.compareDocumentPosition(connectedAi) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getAllByText('Bound Model')).toHaveLength(1);
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
  });

  it('never renders a generic model summary row for legacy model properties', () => {
    (['modelId', 'model'] as const).forEach((property) => {
      const legacyNode: any = {
        ...processNode,
        data: {
          ...processNode.data,
          properties: { promptTemplate: 'Find reliable sources', [property]: 'legacy-model' },
        },
      };

      const { unmount } = render(<InspectorPanel {...baseProps} selectedNode={legacyNode} />);
      expect(screen.queryByText('Model')).not.toBeInTheDocument();
      expect(screen.queryByText('legacy-model')).not.toBeInTheDocument();
      unmount();
    });
  });

  it('lists connected MCP servers and removes them from the process node', () => {
    const onRemoveMcpServer = jest.fn();
    render(
      <InspectorPanel
        {...baseProps}
        selectedNode={processNode}
        connectedMcpServers={[{ nodeId: 'mcp-1', serverName: 'filesystem' }]}
        onConnectMcpServer={jest.fn()}
        onRemoveMcpServer={onRemoveMcpServer}
        loadMcpServers={jest.fn().mockResolvedValue([])}
      />,
    );

    expect(screen.getByText('Connected MCP servers')).toBeInTheDocument();
    expect(screen.getByText('filesystem')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filesystem' }));
    expect(onRemoveMcpServer).toHaveBeenCalledWith('process-1', 'mcp-1');
  });

  it('opens the heading-free MCP picker and connects the chosen server', async () => {
    const onConnectMcpServer = jest.fn();
    const loadMcpServers = jest.fn().mockResolvedValue([
      {
        name: 'github',
        status: 'connected',
        transport: 'stdio',
        rootPath: '/servers/github',
      },
    ]);
    render(
      <InspectorPanel
        {...baseProps}
        selectedNode={processNode}
        connectedMcpServers={[]}
        onConnectMcpServer={onConnectMcpServer}
        onRemoveMcpServer={jest.fn()}
        loadMcpServers={loadMcpServers}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));

    expect(await screen.findByPlaceholderText('Search servers…')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Connect an MCP server' })).toBeInTheDocument();
    expect(screen.queryByText('Connect an MCP server')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText('github'));

    expect(onConnectMcpServer).toHaveBeenCalledWith('process-1', 'github');
  });

  it('changes an MCP node server through the same card picker used by process nodes', async () => {
    const onSelectMcpNodeServer = jest.fn();
    const mcpNode: any = {
      id: 'mcp-1',
      type: 'mcp',
      position: { x: 400, y: 200 },
      selected: true,
      data: {
        type: 'mcp',
        label: 'filesystem',
        properties: { boundServer: 'filesystem', enabledTools: ['read_file'] },
      },
    };
    render(
      <InspectorPanel
        {...baseProps}
        selectedNode={mcpNode}
        loadMcpServers={jest.fn().mockResolvedValue([
          { name: 'filesystem', status: 'connected', transport: 'stdio' },
          { name: 'github', status: 'connected', transport: 'stdio' },
        ])}
        onSelectMcpNodeServer={onSelectMcpNodeServer}
      />,
    );

    expect(screen.getByText('Server')).toBeInTheDocument();
    expect(screen.getAllByText('filesystem')).toHaveLength(2); // inspector title + selected server row
    fireEvent.click(screen.getByRole('button', { name: 'Choose MCP server' }));
    expect(screen.getByRole('dialog', { name: 'Choose MCP server' })).toBeInTheDocument();
    fireEvent.click(await screen.findByText('github'));

    expect(onSelectMcpNodeServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mcp-1' }),
      'github',
    );
  });

  it('uses the same rail for flow-level settings when no node is selected', () => {
    render(<InspectorPanel {...baseProps} selectedNode={null} />);

    fireEvent.change(screen.getByLabelText('Flow name'), { target: { value: 'renamed_flow' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Guided' }));

    expect(baseProps.onFlowNameChange).toHaveBeenCalledWith('renamed_flow');
    expect(baseProps.onAuthoringModeChange).toHaveBeenCalledWith('advanced');
  });

  it('uses beginner language and hides implementation details in simple setup', () => {
    render(<InspectorPanel {...baseProps} beginnerMode selectedNode={processNode} />);

    expect(screen.getByLabelText('Step settings')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Step name')).toHaveValue('Research');
    expect(screen.queryByLabelText('Short note (optional)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('What should the AI do?')).toHaveValue('Find reliable sources');
    expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
    expect(screen.queryByText('process-1')).not.toBeInTheDocument();
    expect(screen.queryByText('model-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows connected apps with a simple picker in beginner mode', async () => {
    const onConnectMcpServer = jest.fn();
    const onRemoveMcpServer = jest.fn();
    render(
      <InspectorPanel
        {...baseProps}
        beginnerMode
        selectedNode={processNode}
        connectedMcpServers={[{ nodeId: 'mcp-1', serverName: 'filesystem' }]}
        onConnectMcpServer={onConnectMcpServer}
        onRemoveMcpServer={onRemoveMcpServer}
        loadMcpServers={jest.fn().mockResolvedValue([{
          name: 'github',
          status: 'connected',
          transport: 'stdio',
          rootPath: '/servers/github',
        }])}
      />,
    );

    expect(screen.getByText('Apps this step can use')).toBeInTheDocument();
    expect(screen.queryByText('Connected MCP servers')).not.toBeInTheDocument();
    expect(screen.getByText('filesystem')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filesystem' }));
    expect(onRemoveMcpServer).toHaveBeenCalledWith('process-1', 'mcp-1');

    fireEvent.click(screen.getByRole('button', { name: 'Add an app' }));
    expect(await screen.findByPlaceholderText('Search apps…')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Choose an app' })).toBeInTheDocument();
    expect(screen.queryByText('/servers/github')).not.toBeInTheDocument();
    expect(screen.getByText('All tools included')).toBeInTheDocument();

    fireEvent.click(screen.getByText('github'));
    expect(onConnectMcpServer).toHaveBeenCalledWith('process-1', 'github');
  });

  it('improves the current prompt with AI and commits the returned text', async () => {
    const onImprovePrompt = jest.fn().mockResolvedValue('Find and cite reliable primary sources.');
    const onCommitNode = jest.fn();
    render(
      <InspectorPanel
        {...baseProps}
        beginnerMode
        selectedNode={processNode}
        onCommitNode={onCommitNode}
        onImprovePrompt={onImprovePrompt}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Improve prompt with AI' }));

    await waitFor(() => expect(onImprovePrompt).toHaveBeenCalledWith(expect.objectContaining({ id: 'process-1' })));
    await waitFor(() => expect(onCommitNode).toHaveBeenLastCalledWith('process-1', expect.objectContaining({
      properties: expect.objectContaining({ promptTemplate: 'Find and cite reliable primary sources.' }),
    })));
    expect(screen.getByDisplayValue('Find and cite reliable primary sources.')).toBeInTheDocument();
  });

  it('shows agents directly below apps in the step inspector', () => {
    const onRemoveAgent = jest.fn();
    render(
      <InspectorPanel
        {...baseProps}
        beginnerMode
        selectedNode={processNode}
        connectedMcpServers={[]}
        onConnectMcpServer={jest.fn()}
        onRemoveMcpServer={jest.fn()}
        loadMcpServers={jest.fn().mockResolvedValue([])}
        currentFlowId="root"
        connectedAgents={[{ nodeId: 'agent-node', flowId: 'writer', flowName: 'Writer' }]}
        onConnectAgent={jest.fn()}
        onRemoveAgent={onRemoveAgent}
      />,
    );

    const appsHeading = screen.getByText('Apps this step can use');
    const agentsHeading = screen.getByText('Agents this step can use');
    expect(appsHeading.compareDocumentPosition(agentsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Writer' }));
    expect(onRemoveAgent).toHaveBeenCalledWith('process-1', 'agent-node');
  });

  it('binds models through a simple AI picker and an expert model-card picker', async () => {
    const models: any[] = [{
      id: 'model-friendly',
      name: 'friendly-model',
      displayName: 'Friendly AI',
      description: 'A helpful model',
      provider: 'openai',
      ApiKey: 'encrypted',
    }];
    const simpleCommit = jest.fn();
    const { unmount } = render(
      <InspectorPanel
        {...baseProps}
        beginnerMode
        selectedNode={processNode}
        models={models}
        onCommitNode={simpleCommit}
      />,
    );

    expect(screen.getByText('AI for this step')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose an AI' }));
    expect(screen.getByRole('dialog', { name: 'Choose an AI for this step' })).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Friendly AI'));
    expect(simpleCommit).toHaveBeenLastCalledWith('process-1', expect.objectContaining({
      properties: expect.objectContaining({
        boundModel: 'model-friendly',
        modelName: 'friendly-model',
      }),
    }));

    unmount();
    render(<InspectorPanel {...baseProps} selectedNode={processNode} models={models} />);
    expect(screen.getByText('Connected AI')).toBeInTheDocument();
    expect(screen.queryByText('(Connected) AI')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose AI' }));
    expect(screen.getByRole('dialog', { name: 'Choose the connected AI' })).toBeInTheDocument();
    expect(screen.getByText('A helpful model')).toBeInTheDocument();
  });

  it('highlights a missing connected AI without showing an add icon', () => {
    render(<InspectorPanel {...baseProps} selectedNode={processNode} models={[]} />);

    const message = screen.getByText('No AI connected.');
    expect(message).toHaveStyle({ fontWeight: 700 });
    expect(screen.getByRole('button', { name: 'Choose AI' })).toBeInTheDocument();
    expect(screen.queryByTestId('AddRoundedIcon')).not.toBeInTheDocument();
  });

  it('never shows the raw node id', () => {
    render(<InspectorPanel {...baseProps} authoringMode="advanced" selectedNode={processNode} />);

    expect(screen.queryByText('process-1')).not.toBeInTheDocument();
  });

  it('shows the subflow target as a clickable pill at the top of the node tab', () => {
    const subflowNode: any = {
      id: 'subflow-1',
      type: 'subflow',
      position: { x: 0, y: 0 },
      selected: true,
      data: {
        type: 'subflow',
        label: 'Convert issues to plans',
        properties: { subflowId: 'child-flow' },
      },
    };
    const onNavigateToFlow = jest.fn();
    render(
      <InspectorPanel
        {...baseProps}
        authoringMode="advanced"
        selectedNode={subflowNode}
        availableAgents={[{ id: 'child-flow', name: 'Research assistant', nodes: [], edges: [] } as any]}
        onNavigateToFlow={onNavigateToFlow}
      />,
    );

    // The pill renders the resolved flow NAME (not the stored id) and opens it.
    expect(screen.queryByText('child-flow')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Research assistant'));
    expect(onNavigateToFlow).toHaveBeenCalledWith('child-flow');
  });
});
