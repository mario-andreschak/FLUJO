import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { GuidedFlowComposer } from '@/frontend/components/Flow/FlowManager/FlowBuilder/GuidedFlowComposer';
import GuidedAgentConnections from '@/frontend/components/Flow/FlowManager/FlowBuilder/GuidedAgentConnections';

jest.mock('@/frontend/components/Flow/FlowDashboard/FlowCard', () => ({
  __esModule: true,
  default: ({ flow, onSelect }: { flow: { id: string; name: string }; onSelect: (id: string) => void }) => (
    <button type="button" onClick={() => onSelect(flow.id)}>{flow.name}</button>
  ),
}));

const processNode: any = {
  id: 'process-1',
  type: 'process',
  position: { x: 0, y: 100 },
  data: {
    label: 'Flow Architect',
    type: 'process',
    properties: { promptTemplate: 'Plan the work', boundModel: 'model-1' },
  },
};

const flow = (id: string, name: string): any => ({
  id,
  name,
  nodes: [],
  edges: [],
});

describe('Guided step connections', () => {
  it('puts Apps and other-Agent lists inside each purple process card', () => {
    const removeMcp = jest.fn();
    const removeAgent = jest.fn();
    render(
      <GuidedFlowComposer
        nodes={[processNode]}
        orderedStepIds={[processNode.id]}
        selectedNodeId={processNode.id}
        flowName="Architect"
        flowNameError={null}
        onFlowNameChange={jest.fn()}
        onSelectNode={jest.fn()}
        onAddTask={jest.fn()}
        onSwitchAdvanced={jest.fn()}
        currentFlowId="current"
        availableAgents={[flow('helper', 'Research Agent')]}
        mcpConnectionsByNode={new Map([[
          processNode.id,
          [{ nodeId: 'mcp-1', serverName: 'github' }],
        ]])}
        agentConnectionsByNode={new Map([[
          processNode.id,
          [{ nodeId: 'subflow-1', flowId: 'helper', flowName: 'Research Agent' }],
        ]])}
        onConnectMcpServer={jest.fn()}
        onRemoveMcpServer={removeMcp}
        loadMcpServers={jest.fn().mockResolvedValue([])}
        onConnectAgent={jest.fn()}
        onRemoveAgent={removeAgent}
      />,
    );

    expect(screen.getByText('Uses Apps')).toBeInTheDocument();
    expect(screen.getByText('Agents this step can use')).toBeInTheDocument();
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.getByText('Research Agent')).toBeInTheDocument();
    expect(screen.getByText('Isolated input · Condensed output')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove github' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Research Agent' }));
    expect(removeMcp).toHaveBeenCalledWith('process-1', 'mcp-1');
    expect(removeAgent).toHaveBeenCalledWith('process-1', 'subflow-1');
  });

  it('uses a searchable agent picker and excludes the current or already-connected agent', () => {
    const connect = jest.fn();
    render(
      <GuidedAgentConnections
        processNodeId="process-1"
        currentFlowId="current"
        flows={[
          flow('current', 'Current Agent'),
          flow('connected', 'Connected Agent'),
          flow('helper', 'Research Agent'),
        ]}
        connections={[{ nodeId: 'subflow-1', flowId: 'connected', flowName: 'Connected Agent' }]}
        onConnect={connect}
        onRemove={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    expect(screen.getByRole('dialog', { name: 'Choose another agent' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search agents…')).toBeInTheDocument();
    expect(screen.queryByText('Current Agent')).not.toBeInTheDocument();
    expect(screen.getAllByText('Connected Agent')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Research Agent' }));
    expect(connect).toHaveBeenCalledWith('process-1', 'helper');
  });
});
