import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ModelTurnInspector, { invocationView } from '@/frontend/components/Chat/ModelTurnInspector';
import type { ModelTurnSnapshot } from '@/shared/types/modelTurn';

function codexSnapshot(): ModelTurnSnapshot {
  return {
    version: 1,
    entry: {
      id: 'dispatch-1',
      conversationId: 'conversation-1',
      node: { nodeId: 'node-1', nodeName: 'Research' },
      modelId: 'model-1',
      modelName: 'Codex',
      adapter: 'codex-cli',
      operation: 'thread.runStreamed',
      timestamp: 1,
      outcome: 'completed',
      attempt: 1,
      canonicalMessageCount: 0,
      wireMessageCount: 0,
      mediaCount: 0,
      archiveVersion: 1,
    },
    canonicalMessages: [],
    genericWire: [],
    sdkRequest: {
      input: 'Inspect the code',
      options: { signal: '[AbortSignal]' },
      // Historical archives carried this diagnostic beside the real call args.
      thread: { resumed: true, id: 'thread-1', options: { model: 'gpt-5' } },
    },
    media: [],
  };
}

describe('ModelTurnInspector request detail', () => {
  it('maps an archive to only the arguments accepted by the adapter call', () => {
    const invocation = invocationView(codexSnapshot());
    expect(invocation.callee).toBe('thread.runStreamed');
    expect(invocation.parameters.map(parameter => parameter.name)).toEqual(['input', 'options']);
    expect(invocation.parameters).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'thread' }),
    ]));
  });

  it('renders a TypeScript call whose parameters reveal their captured values', () => {
    render(
      <ModelTurnInspector
        snapshot={codexSnapshot()}
        conversationId="conversation-1"
        tab="request"
        onTabChange={() => undefined}
      />,
    );

    expect(screen.getByTestId('request-code-canvas')).toHaveTextContent(
      'const response = await thread.runStreamed(input, options);',
    );
    expect(screen.getByTestId('request-parameter-value')).toHaveTextContent('Inspect the code');

    fireEvent.click(screen.getByRole('button', { name: 'Inspect options' }));
    expect(screen.getByTestId('request-parameter-value')).toHaveTextContent('[AbortSignal]');
    expect(screen.getByTestId('request-code-canvas')).not.toHaveTextContent('thread-1');
  });
});
