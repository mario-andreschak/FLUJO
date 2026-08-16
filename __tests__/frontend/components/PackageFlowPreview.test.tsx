import { fireEvent, render, screen } from '@testing-library/react';
import PackageFlowPreview from '@/frontend/components/Packages/PackageFlowPreview';

jest.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ReactFlow: () => <div data-testid="flow-canvas" />,
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes', () => ({
  StartNode: () => null, ProcessNode: () => null, FinishNode: () => null, MCPNode: () => null,
  SubflowNode: () => null, ResourceNode: () => null, SignalNode: () => null, TriggerNode: () => null, StaticNode: () => null,
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/CustomEdges', () => ({
  CustomEdge: () => null, MCPEdge: () => null, ResourceEdge: () => null,
}));
jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    formatNumber: (value: number) => String(value),
    t: (key: string, values?: Record<string, string>) => {
      const names: Record<string, string> = {
        'packages.install.nodesEdges': `${values?.nodes} nodes, ${values?.edges} edges`,
        'packages.install.showGraph': 'Show graph',
        'packages.install.showList': 'Show list',
        'packages.install.graphUnavailable': 'Graph unavailable',
        'packages.install.graphAria': `Graph for ${values?.name}`,
        'packages.install.outlineAria': `Outline for ${values?.name}`,
        'packages.install.emptyFlow': 'Empty flow',
      };
      return names[key] ?? key;
    },
  }),
}));

const flow = {
  name: 'Example flow', effectiveName: 'Example flow', nodeCount: 1, edgeCount: 0,
  nodeSummary: [{ id: 'start', type: 'start', label: 'Start' }],
  graph: { nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }], edges: [] },
};

describe('PackageFlowPreview', () => {
  it('switches between a read-only graph and textual outline', () => {
    render(<PackageFlowPreview flow={flow as never} />);
    expect(screen.getByRole('img', { name: 'Graph for Example flow' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show list' }));
    expect(screen.getByLabelText('Outline for Example flow')).toBeInTheDocument();
    expect(screen.getByText('Start')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show graph' }));
    expect(screen.getByTestId('flow-canvas')).toBeInTheDocument();
  });

  it('falls back to an accessible outline for an unavailable graph', () => {
    render(<PackageFlowPreview flow={{ ...flow, graph: undefined, graphError: 'invalid' } as never} />);
    expect(screen.getByText('Graph unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Outline for Example flow')).toBeInTheDocument();
  });
});
