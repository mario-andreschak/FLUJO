/** @jest-environment jsdom */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/FlowPreview', () => ({
  __esModule: true,
  default: ({
    flow,
    relayoutTopToBottom,
  }: {
    flow: { nodes: unknown[] };
    relayoutTopToBottom?: boolean;
  }) => (
    <div
      data-testid="expert-flow-renderer"
      data-relayout-top-to-bottom={String(relayoutTopToBottom === true)}
    >
      {flow.nodes.length} nodes
    </div>
  ),
}));

import VisualGenerationCanvas, {
  initialVisualGenerationState,
  visualGenerationReducer,
} from '@/frontend/components/Flow/FlowManager/VisualGenerationCanvas';

const root = {
  id: 'root',
  name: 'Research lead',
  goal: 'Research and summarize a topic',
  depth: 0,
  steps: [],
  status: 'building' as const,
};
const child = {
  id: 'child',
  name: 'Source checker',
  goal: 'Verify sources',
  depth: 1,
  parentAgentId: 'root',
  parentStepId: 'research',
  steps: [],
  status: 'building' as const,
};

describe('VisualGenerationCanvas', () => {
  it('reduces streamed events into a navigable agent tree with visible decisions', () => {
    let state = visualGenerationReducer(initialVisualGenerationState, {
      type: 'session-started',
      sessionId: 'session',
      maxDepth: 8,
      message: 'Starting',
    });
    state = visualGenerationReducer(state, { type: 'agent-created', agent: root });
    state = visualGenerationReducer(state, {
      type: 'step-added',
      agentId: 'root',
      step: {
        id: 'research',
        label: 'Research topic',
        task: 'Find reliable sources.',
        tools: [],
        connectedAgentIds: ['child'],
      },
    });
    state = visualGenerationReducer(state, {
      type: 'flow-preview',
      agentId: 'root',
      revision: 1,
      flow: {
        id: 'root',
        name: 'Research lead',
        nodes: [{
          id: 'start',
          type: 'start',
          position: { x: 0, y: 0 },
          data: { label: 'Start', type: 'start' },
        }],
        edges: [],
      },
    });
    state = visualGenerationReducer(state, { type: 'agent-created', agent: child });
    state = visualGenerationReducer(state, {
      type: 'suggestions',
      agentId: 'root',
      stepId: 'research',
      tools: [{ server: 'web', tool: 'search', reason: 'finds sources' }],
      agents: [],
    });
    state = visualGenerationReducer(state, {
      type: 'suggestion-decision',
      decision: {
        id: 'decision',
        agentId: 'root',
        stepId: 'research',
        kind: 'tool',
        label: 'web / search',
        decision: 'accepted',
        reason: 'Research needs current sources.',
      },
    });
    state = visualGenerationReducer(state, { type: 'focus', agentId: 'root' });

    const onSelect = jest.fn();
    render(<VisualGenerationCanvas state={state} working onSelectAgent={onSelect} />);
    expect(screen.getAllByText('Research lead').length).toBeGreaterThan(0);
    expect(screen.getByText('Research topic')).toBeInTheDocument();
    expect(screen.getByText('Using web / search')).toBeInTheDocument();
    expect(screen.getByText('Source checker · level 1')).toBeInTheDocument();
    expect(screen.getByText('Expert-mode preview')).toBeInTheDocument();
    expect(screen.getByText('Re-layout top-to-bottom')).toBeInTheDocument();
    expect(screen.getByTestId('expert-flow-renderer')).toHaveTextContent('1 nodes');
    expect(screen.getByTestId('expert-flow-renderer')).toHaveAttribute(
      'data-relayout-top-to-bottom',
      'true',
    );
    fireEvent.click(screen.getByText('Source checker · level 1'));
    expect(onSelect).toHaveBeenCalledWith('child');
  });
});
