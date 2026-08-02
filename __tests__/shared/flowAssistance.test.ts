import type { Flow } from '@/shared/types/flow';
import {
  analyzeFlowPlausibility,
  applyStepToolSelections,
  collectReferencedFlows,
  inferFlowUsageContexts,
} from '@/utils/shared/flowAssistance';

const processFlow = (): Flow => ({
  id: 'flow-1',
  name: 'Helper',
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start', properties: {} } },
    {
      id: 'work',
      type: 'process',
      position: { x: 0, y: 100 },
      data: {
        label: 'Work',
        type: 'process',
        properties: { promptTemplate: 'Read the project notes', inputMode: 'latest-message' },
      },
    },
    { id: 'finish', type: 'finish', position: { x: 0, y: 200 }, data: { label: 'Finish', type: 'finish', properties: {} } },
  ],
  edges: [
    { id: 'a', source: 'start', target: 'work', data: { edgeType: 'standard' } },
    { id: 'b', source: 'work', target: 'finish', data: { edgeType: 'standard' } },
  ],
});

describe('flow assistance', () => {
  it('attaches approved live tools and canonical pills idempotently', () => {
    const once = applyStepToolSelections(processFlow(), {
      nodeId: 'work',
      selections: [{ server: 'files', tool: 'read_file', reason: 'the step reads project notes' }],
      availableTools: { files: ['read_file', 'write_file'] },
      proposedPrompt: 'Read the project notes carefully.',
    });
    expect(once.nodes.filter((node) => node.data.type === 'mcp')).toHaveLength(1);
    expect(once.edges.filter((edge) => edge.data?.edgeType === 'mcp')).toHaveLength(1);
    expect(once.nodes.find((node) => node.id === 'work')?.data.properties?.promptTemplate)
      .toContain('${tool:files__read_file}');

    const twice = applyStepToolSelections(once, {
      nodeId: 'work',
      selections: [{ server: 'files', tool: 'read_file', reason: 'the step reads project notes' }],
      availableTools: { files: ['read_file', 'write_file'] },
      proposedPrompt: once.nodes.find((node) => node.id === 'work')?.data.properties?.promptTemplate,
    });
    expect(twice.nodes).toHaveLength(once.nodes.length);
    expect(twice.edges).toHaveLength(once.edges.length);
    expect((twice.nodes.find((node) => node.id === 'work')?.data.properties?.promptTemplate.match(/\$\{tool:files__read_file\}/g) ?? []))
      .toHaveLength(1);
  });

  it('drops selections that are not currently exposed', () => {
    const result = applyStepToolSelections(processFlow(), {
      nodeId: 'work',
      selections: [{ server: 'files', tool: 'delete_everything', reason: 'invented' }],
      availableTools: { files: ['read_file'] },
    });
    expect(result.nodes.filter((node) => node.data.type === 'mcp')).toHaveLength(0);
    expect(result.nodes.find((node) => node.id === 'work')?.data.properties?.promptTemplate)
      .toBe('Read the project notes');
  });

  it('removes newly proposed pills for suggestions the user did not approve', () => {
    const result = applyStepToolSelections(processFlow(), {
      nodeId: 'work',
      selections: [{ server: 'files', tool: 'read_file', reason: 'the step reads notes' }],
      availableTools: { files: ['read_file', 'write_file'] },
      proposedPrompt: 'Read with ${tool:files__read_file}; do not write with ${tool:files__write_file}.',
    });
    const prompt = result.nodes.find((node) => node.id === 'work')?.data.properties?.promptTemplate;
    expect(prompt).toContain('${tool:files__read_file}');
    expect(prompt).not.toContain('${tool:files__write_file}');
  });

  it('repairs small Process flows to full-history input and latest-message output', () => {
    const result = analyzeFlowPlausibility(processFlow());
    expect(result.repairedFlow.nodes.find((node) => node.id === 'work')?.data.properties)
      .toEqual(expect.objectContaining({ inputMode: 'full-history', outputMode: 'latest-message' }));
    expect(result.patches).toHaveLength(1);
  });

  it('classifies a bidirectional Process/Subflow connection as a queue-backed sub-agent', () => {
    const flow = processFlow();
    flow.nodes.splice(2, 0, {
      id: 'child',
      type: 'subflow',
      position: { x: 200, y: 100 },
      data: {
        label: 'Researcher',
        type: 'subflow',
        properties: { subflowId: 'child-flow', promptTemplate: 'default task', outputMode: 'steps' },
      },
    });
    flow.edges.push({ id: 'handoff', source: 'work', target: 'child', data: { edgeType: 'standard', bidirectional: true } });
    const result = analyzeFlowPlausibility(flow);
    const props = result.repairedFlow.nodes.find((node) => node.id === 'child')?.data.properties;
    expect(props).toEqual(expect.objectContaining({
      inputMode: 'isolated',
      outputMode: 'final-only',
    }));
    expect(props).not.toHaveProperty('allowCallerPrompt');
    expect(props).not.toHaveProperty('allowCallerFanout');
    expect(props?.promptTemplate).toBeUndefined();
  });

  it('classifies ordinary subflow use and trigger-wave context', () => {
    const child = processFlow();
    child.id = 'child-flow';
    const parent: Flow = {
      id: 'parent',
      name: 'Parent',
      nodes: [{
        id: 'child-node',
        type: 'subflow',
        position: { x: 0, y: 0 },
        data: { label: 'Child', type: 'subflow', properties: { subflowId: 'child-flow' } },
      }],
      edges: [],
    };
    const contexts = inferFlowUsageContexts(child, {
      allFlows: [parent, child],
      plannedExecutions: [{ id: 'exec-1', name: 'Nightly', flowId: child.id, trigger: { type: 'schedule' } }],
      waveExecutions: new Map([['exec-1', 'Trigger Wave nightly']]),
    });
    expect(contexts.map((context) => context.kind)).toEqual(expect.arrayContaining(['subflow-chain', 'trigger-wave']));
  });

  it('treats an unsaved intended headless flow as non-interactive context', () => {
    const candidate = processFlow();
    candidate.nodes.find((node) => node.id === 'work')!.data.properties!.promptTemplate = 'Ask the user to confirm first.';
    const result = analyzeFlowPlausibility(candidate, { intendedContext: 'headless' });
    expect(result.contexts).toContainEqual(expect.objectContaining({ kind: 'planned-execution' }));
    expect(result.contexts).not.toContainEqual(expect.objectContaining({ kind: 'chat' }));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'headless-interaction-assumption' }));
  });

  it('inspects nested and parallel subflows once, even when the bundle cycles', () => {
    const root = processFlow();
    root.nodes.push({
      id: 'children',
      type: 'subflow',
      position: { x: 100, y: 100 },
      data: {
        label: 'Children',
        type: 'subflow',
        properties: { subflowId: 'child-a', parallelSubflowIds: ['child-b'] },
      },
    });
    const childA = { ...processFlow(), id: 'child-a', name: 'Child A' };
    childA.nodes.push({
      id: 'back',
      type: 'subflow',
      position: { x: 100, y: 100 },
      data: { label: 'Back', type: 'subflow', properties: { subflowId: root.id } },
    });
    const childB = { ...processFlow(), id: 'child-b', name: 'Child B' };
    expect(collectReferencedFlows(root, [childA, childB, root]).map((flow) => flow.id))
      .toEqual([root.id, childA.id, childB.id]);
  });
});
