import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ModelTurnTimeline from '@/frontend/components/Chat/ModelTurnTimeline';
import type { ModelTurnIndexEntry } from '@/shared/types/modelTurn';

const turns: ModelTurnIndexEntry[] = [0, 1, 2].map(index => ({
  id: `dispatch_${index}`,
  conversationId: 'conversation_1',
  node: { nodeId: `node_${index}`, nodeName: `Node ${index + 1}` },
  modelId: 'model_1',
  modelName: 'Example Model',
  adapter: 'openai',
  operation: 'chat.completions.create',
  timestamp: 1_000 + index,
  outcome: 'completed',
  attempt: index + 1,
  canonicalMessageCount: 2,
  wireMessageCount: 2,
  mediaCount: 0,
  archiveVersion: 1,
}));

function Harness() {
  const [selectedId, setSelectedId] = useState(turns[0].id);
  const [followLive, setFollowLive] = useState(false);
  return (
    <ModelTurnTimeline
      turns={turns}
      selectedId={selectedId}
      followLive={followLive}
      unseenCount={2}
      onSelect={(turn, atEnd) => {
        setSelectedId(turn.id);
        setFollowLive(atEnd);
      }}
    />
  );
}

describe('ModelTurnTimeline', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: jest.fn(),
    });
  });

  it('steps by keyboard and automatically follows live at the final marker', () => {
    render(<Harness />);
    const timeline = screen.getByRole('listbox', { name: 'Model turn timeline' });

    expect(screen.getByText('2 new')).toBeInTheDocument();
    fireEvent.keyDown(timeline, { key: 'ArrowRight' });
    expect(screen.getByRole('option', { name: /2\. Node 2/ })).toHaveAttribute('aria-current', 'step');

    fireEvent.keyDown(timeline, { key: 'End' });
    expect(screen.getByRole('option', { name: /3\. Node 3/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Live')).toBeInTheDocument();
  });
});

