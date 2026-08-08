import { flowService } from '@/frontend/services/flow';

describe('FlowBuilder node creation', () => {
  it('creates process nodes with full-conversation input', () => {
    const node = flowService.createNode('process', { x: 10, y: 20 });

    expect(node.data.properties).toEqual({ inputMode: 'full-history' });
  });

  it('defaults new subflow nodes to separate parallel result messages', () => {
    const node = flowService.createNode('subflow', { x: 10, y: 20 });

    expect(node.data.properties).toEqual({ resultPresentation: 'separate' });
  });

  it('does not add process input settings to unrelated node types', () => {
    expect(flowService.createNode('static', { x: 10, y: 20 }).data.properties).toEqual({ entries: [] });
    expect(flowService.createNode('mcp', { x: 10, y: 20 }).data.properties).toEqual({});
    expect(flowService.createNode('finish', { x: 10, y: 20 }).data.properties).toEqual({});
  });
});
