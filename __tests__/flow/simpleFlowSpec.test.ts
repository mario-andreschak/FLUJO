import {
  compileSimpleFlowSpec,
  lowerSimpleFlowSpec,
  SIMPLE_FLOW_SPEC_SCHEMA,
  type SimpleFlowSpec,
} from '@/utils/shared/simpleFlowSpec';

const context = {
  models: [{ id: 'model-1', name: 'small-model' }, { id: 'model-2', name: 'large-model' }],
  servers: [{ name: 'web' }, { name: 'files' }],
  serverTools: {
    web: ['search'],
    files: ['write'],
  },
  flows: [{ id: 'flow-review', name: 'Reviewer' }],
};

describe('SimpleFlowSpec', () => {
  it('publishes a closed, compact JSON schema', () => {
    expect(SIMPLE_FLOW_SPEC_SCHEMA.additionalProperties).toBe(false);
    expect(SIMPLE_FLOW_SPEC_SCHEMA.required).toEqual(['name', 'goal', 'steps']);
    expect(SIMPLE_FLOW_SPEC_SCHEMA.properties.steps.items.additionalProperties).toBe(false);
    expect(Object.keys(SIMPLE_FLOW_SPEC_SCHEMA.properties)).toEqual([
      'profile', 'version', 'name', 'goal', 'model', 'steps', 'routes',
    ]);
  });

  it('infers start, finish, and a linear edge chain', () => {
    const simple: SimpleFlowSpec = {
      name: 'research_report',
      goal: 'Research and write a report',
      model: 'model-1',
      steps: [
        { id: 'research', task: 'Find reliable sources', tools: ['web/search'] },
        { id: 'write', task: 'Write the final report' },
      ],
    };

    const lowered = lowerSimpleFlowSpec(simple);
    expect(lowered.issues).toEqual([]);
    expect(lowered.spec.nodes.map((node) => [node.key, node.type])).toEqual([
      ['__start', 'start'],
      ['research', 'process'],
      ['write', 'process'],
      ['__finish', 'finish'],
    ]);
    expect(lowered.spec.edges).toEqual([
      { from: '__start', to: 'research' },
      { from: 'research', to: 'write' },
      { from: 'write', to: '__finish' },
    ]);
    expect(lowered.spec.nodes[1]).toEqual(expect.objectContaining({
      model: 'model-1',
      inputMode: 'full-history',
      outputMode: 'latest-message',
      servers: [{ name: 'web', tools: ['search'] }],
    }));
  });

  it('supports an existing-flow step and a per-step model override', () => {
    const result = compileSimpleFlowSpec({
      name: 'delegated_review',
      goal: 'Draft and review',
      model: 'model-1',
      steps: [
        { id: 'draft', task: 'Create a draft', model: 'model-2' },
        { id: 'review', task: 'Review the draft', flow: 'Reviewer' },
      ],
    }, context);

    expect(result.errorCount).toBe(0);
    expect(result.flow?.nodes.find((node) => node.data.label === 'Draft')?.data.properties)
      .toEqual(expect.objectContaining({ boundModel: 'model-2' }));
    expect(result.flow?.nodes.find((node) => node.type === 'subflow')?.data.properties)
      .toEqual(expect.objectContaining({ subflowId: 'flow-review' }));
  });

  it('infers entry and terminal edges around explicit branches', () => {
    const lowered = lowerSimpleFlowSpec({
      name: 'branch',
      goal: 'Route a review',
      model: 'model-1',
      steps: [
        { id: 'review', task: 'Return PASS or FAIL' },
        { id: 'approve', task: 'Approve it' },
        { id: 'revise', task: 'Revise it' },
      ],
      routes: [
        { from: 'review', to: 'approve', when: { kind: 'contains', value: 'PASS' } },
        { from: 'review', to: 'revise' },
      ],
    });

    expect(lowered.spec.edges).toEqual(expect.arrayContaining([
      { from: '__start', to: 'review' },
      { from: 'review', to: 'approve', condition: { kind: 'contains', value: 'PASS' } },
      { from: 'review', to: 'revise' },
      { from: 'approve', to: '__finish' },
      { from: 'revise', to: '__finish' },
    ]));
  });

  it('reports duplicate steps and unresolved routes without throwing', () => {
    const lowered = lowerSimpleFlowSpec({
      name: 'bad',
      goal: 'Still produce a reviewable draft',
      steps: [
        { id: 'work', task: 'First' },
        { id: 'work', task: 'Duplicate' },
      ],
      routes: [{ from: 'work', to: 'missing' }],
    });

    expect(lowered.issues.map((issue) => issue.code)).toEqual([
      'simple-step-id-duplicate',
      'simple-route-unresolved',
    ]);
    expect(lowered.spec.nodes.filter((node) => node.key === 'work')).toHaveLength(1);
  });
});
