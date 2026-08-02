import {
  configureGuidedSubagentEdge,
  configureGuidedSubagentNode,
  getGuidedSubagentLinks,
  isCanonicalGuidedSubagent,
} from '@/utils/shared/guidedSubagents';

const preparedNode: any = {
  id: 'subflow-1',
  type: 'subflow',
  position: { x: 300, y: 100 },
  data: { label: 'Subflow Node', type: 'subflow', properties: {} },
};

describe('Guided subagent wiring', () => {
  it('configures picker-created agents with isolated input and condensed output', () => {
    const node = configureGuidedSubagentNode(preparedNode, {
      id: 'agent-research',
      name: 'Research Agent',
      description: 'Finds reliable sources',
    });

    expect(node.data).toEqual(expect.objectContaining({
      label: 'Research Agent',
      description: 'Finds reliable sources',
      properties: expect.objectContaining({
        subflowId: 'agent-research',
        inputMode: 'isolated',
        outputMode: 'final-only',
      }),
    }));
    expect(isCanonicalGuidedSubagent(node)).toBe(true);
  });

  it('marks and recognizes the bidirectional Process/Subflow subagent shape', () => {
    const process: any = {
      id: 'process-1',
      type: 'process',
      position: { x: 0, y: 0 },
      data: { label: 'Architect', type: 'process', properties: {} },
    };
    const subflow = configureGuidedSubagentNode(preparedNode, {
      id: 'agent-research',
      name: 'Research Agent',
    });
    const edge = configureGuidedSubagentEdge({
      id: 'process-to-agent',
      source: process.id,
      target: subflow.id,
      data: { edgeType: 'standard' },
    });

    expect(edge.data).toEqual(expect.objectContaining({ bidirectional: true }));
    expect(getGuidedSubagentLinks([process, subflow], [edge])).toEqual([{
      processNodeId: 'process-1',
      subflowNodeId: 'subflow-1',
    }]);
  });
});
