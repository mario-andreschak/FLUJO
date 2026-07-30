import { flowService } from '@/frontend/services/flow';

describe('FlowBuilder node creation', () => {
  it('creates process nodes with full-conversation input', () => {
    const node = flowService.createNode('process', { x: 10, y: 20 });

    expect(node.data.properties).toEqual({ inputMode: 'full-history' });
  });

  it('does not add process input settings to other node types', () => {
    const node = flowService.createNode('finish', { x: 10, y: 20 });

    expect(node.data.properties).toEqual({});
  });
});
