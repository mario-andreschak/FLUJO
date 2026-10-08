/** @jest-environment jsdom */
import React from 'react';
import { render, screen } from '@testing-library/react';

const computeAutoLayout = jest.fn((nodes: Array<{ id: string }>) => nodes.map((node) => ({
  ...node,
  position: { x: 100, y: 200 },
})));

jest.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  ReactFlow: ({ nodes }: { nodes: Array<{ id: string; position: { x: number; y: number } }> }) => (
    <div data-testid="preview-layout">
      {nodes.map((node) => `${node.id}:${node.position.x},${node.position.y}`).join('|')}
    </div>
  ),
  Background: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ConnectionLineType: { SmoothStep: 'smoothstep' },
}));

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/Canvas', () => ({
  nodeTypes: {},
  edgeTypes: {},
}));

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/autoLayout', () => ({
  computeAutoLayout: (...args: unknown[]) => computeAutoLayout(...(args as [Array<{ id: string }>])),
}));

import FlowPreview from '@/frontend/components/Flow/FlowManager/FlowBuilder/FlowPreview';

const flow = {
  id: 'flow',
  name: 'Flow',
  nodes: [
    {
      id: 'start',
      type: 'start',
      position: { x: 7, y: 11 },
      data: { label: 'Start', type: 'start' },
    },
    {
      id: 'finish',
      type: 'finish',
      position: { x: 13, y: 17 },
      data: { label: 'Finish', type: 'finish' },
    },
  ],
  edges: [],
};

describe('FlowPreview layout mode', () => {
  beforeEach(() => computeAutoLayout.mockClear());

  it('uses the full re-layout engine when top-to-bottom re-layout is requested', () => {
    render(<FlowPreview flow={flow} relayoutTopToBottom />);

    expect(computeAutoLayout).toHaveBeenCalledWith(flow.nodes, []);
    expect(screen.getByTestId('preview-layout')).toHaveTextContent('start:100,200|finish:100,200');
  });

  it('keeps stored coordinates when re-layout is not requested', () => {
    render(<FlowPreview flow={flow} />);

    expect(computeAutoLayout).not.toHaveBeenCalled();
    expect(screen.getByTestId('preview-layout')).toHaveTextContent('start:7,11|finish:13,17');
  });
});
