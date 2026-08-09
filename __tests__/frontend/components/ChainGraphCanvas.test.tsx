import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ReactFlow: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="rf__wrapper">{children}</div>
  ),
  Background: () => <div data-testid="rf__background" />,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => <div data-testid="rf__controls" />,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  useNodesState: (nodes: unknown[]) => [nodes, jest.fn(), jest.fn()],
  useEdgesState: (edges: unknown[]) => [edges, jest.fn(), jest.fn()],
}));

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: string) =>
      key === 'chainChat.canvasLabel' ? 'Conversation chain graph' : key,
  }),
}));

import ChainGraphCanvas, {
  DEFAULT_CHAIN_GRAPH_HEIGHT,
} from '@/frontend/components/ConversationChainGraph/ChainGraphCanvas';

describe('ChainGraphCanvas', () => {
  it('gives React Flow a definite default height', () => {
    render(<ChainGraphCanvas nodes={[]} onOpenConversation={jest.fn()} />);

    const canvas = screen.getByRole('application', { name: 'Conversation chain graph' });
    expect(canvas).toHaveStyle({ height: DEFAULT_CHAIN_GRAPH_HEIGHT });
    expect(canvas).not.toHaveStyle({ height: '100%' });
    expect(screen.getByTestId('rf__wrapper')).toBeInTheDocument();
  });

  it('honors an explicit height supplied by an embedding view', () => {
    render(<ChainGraphCanvas nodes={[]} onOpenConversation={jest.fn()} height={512} />);

    expect(screen.getByRole('application', { name: 'Conversation chain graph' })).toHaveStyle({
      height: '512px',
    });
  });
});
