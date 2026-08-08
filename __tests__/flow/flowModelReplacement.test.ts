import {
  collectFlowModelUsage,
  remapFlowModelBindings,
} from '@/utils/shared/flowModelReplacement';

const flow = (id: string, bindings: Array<{ id?: string; name?: string }>) => ({
  id,
  name: `Flow ${id}`,
  nodes: bindings.map((binding, index) => ({
    id: `${id}-${index}`,
    data: {
      properties: binding.id
        ? { boundModel: binding.id, modelName: binding.name, promptTemplate: 'keep me' }
        : { promptTemplate: 'unbound' },
    },
  })),
});

describe('flow model replacement', () => {
  it('remaps boundModel and its cached name without mutating the source flow', () => {
    const source = flow('one', [
      { id: 'old-a', name: 'old-technical-a' },
      { id: 'old-b', name: 'old-technical-b' },
      {},
    ]);

    const result = remapFlowModelBindings(source, {
      'old-a': { id: 'new-a', name: 'new-technical-a' },
    });

    expect(result.replacedNodeCount).toBe(1);
    expect(result.flow).not.toBe(source);
    expect(result.flow.nodes[0].data.properties).toEqual({
      boundModel: 'new-a',
      modelName: 'new-technical-a',
      promptTemplate: 'keep me',
    });
    expect(result.flow.nodes[1]).toBe(source.nodes[1]);
    expect(source.nodes[0].data.properties.boundModel).toBe('old-a');
  });

  it('returns the original flow when no binding changes', () => {
    const source = flow('one', [{ id: 'old-a', name: 'old-technical-a' }]);
    const result = remapFlowModelBindings(source, {});

    expect(result).toEqual({ flow: source, replacedNodeCount: 0 });
    expect(result.flow).toBe(source);
  });

  it('summarizes unique model usage across flows and identifies deleted models', () => {
    const usages = collectFlowModelUsage(
      [
        flow('one', [
          { id: 'model-a', name: 'a' },
          { id: 'model-a', name: 'a' },
          { id: 'missing', name: 'Former model' },
        ]),
        flow('two', [{ id: 'model-a', name: 'a' }]),
      ],
      [{ id: 'model-a', name: 'a', displayName: 'Model A' }],
    );

    expect(usages).toEqual([
      {
        modelId: 'missing',
        label: 'Former model',
        flowCount: 1,
        nodeCount: 1,
        missing: true,
      },
      {
        modelId: 'model-a',
        label: 'Model A',
        flowCount: 2,
        nodeCount: 3,
        missing: false,
      },
    ]);
  });
});
