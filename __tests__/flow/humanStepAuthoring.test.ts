/**
 * A Human step (#1095) can be written as a FlowSpec, as a guided simple step and on the
 * canvas, and each of these keeps it exactly as authored.
 */
import Ajv from 'ajv';
import { compileFlowSpec, flowToSpec, type FlowSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';
import { flowUsesAdvancedFeatures } from '@/utils/shared/flowAuthoringProfile';
import { getConnectionError, validTargetTypesFor } from '@/utils/shared/connectionRules';
import { compileSimpleFlowSpec, lowerSimpleFlowSpec, SIMPLE_FLOW_SPEC_SCHEMA } from '@/utils/shared/simpleFlowSpec';
import type { HumanStepProperties } from '@/utils/shared/humanStep';

const human: HumanStepProperties = {
  mode: 'input',
  title: 'Order details',
  prompt: 'Check the order for ${var:customer}.',
  review: { source: 'variable', variable: 'draft', format: 'json' },
  fields: [
    { name: 'budget', label: 'Budget', type: 'number', required: true, min: 0, max: 1000 },
    { name: 'size', type: 'choice', options: ['small', 'large'] },
    { name: 'note', type: 'longText', maxLength: 200 },
  ],
  outputVariable: 'answers',
  timeoutMinutes: 90,
  onReject: 'continue',
  onTimeout: 'stop',
  rejectedText: 'Not sent.',
  timedOutText: 'Nobody looked.',
};

const specWith = (step: Record<string, unknown>, edges: FlowSpec['edges'] = [
  { from: 'start', to: 'ask' }, { from: 'ask', to: 'finish' },
]): FlowSpec => ({
  name: 'ask_a_person',
  nodes: [
    { key: 'start', type: 'start' },
    { key: 'ask', type: 'human', label: 'Ask', ...step } as FlowSpec['nodes'][number],
    { key: 'finish', type: 'finish' },
  ],
  edges,
});

const humanNode = (compiled: ReturnType<typeof compileFlowSpec>) =>
  compiled.flow!.nodes.find((node) => node.type === 'human')!;
const codes = (issues: Array<{ code: string }>) => issues.map((issue) => issue.code);

describe('Human step in a FlowSpec', () => {
  it('keeps every Human step setting through the compiler and back', () => {
    const compiled = compileFlowSpec(specWith({ ...human }));

    expect(compiled.errorCount).toBe(0);
    expect(humanNode(compiled).data.properties).toEqual(human);

    const back = flowToSpec(compiled.flow!);
    const node = back.nodes.find((candidate) => candidate.type === 'human')!;
    expect(node).toEqual({ key: humanNode(compiled).id, type: 'human', label: 'Ask', ...human });

    const again = compileFlowSpec(back);
    expect(again.errorCount).toBe(0);
    expect(humanNode(again).data.properties).toEqual(human);
  });

  it('keeps a condition on an edge that leaves a Human step', () => {
    const condition = { kind: 'equals' as const, value: 'approved', target: 'variable' as const, variable: 'review.outcome', from: 'person' as const };
    const compiled = compileFlowSpec({
      ...specWith({ prompt: 'Send it?', onReject: 'continue' }),
      nodes: [...specWith({ prompt: 'Send it?', onReject: 'continue' }).nodes, { key: 'stop', type: 'finish' }],
      edges: [{ from: 'start', to: 'ask' }, { from: 'ask', to: 'finish', condition }, { from: 'ask', to: 'stop' }],
    });

    expect(codes(compiled.issues)).not.toContain('edge-condition-non-process');
    const conditioned = compiled.flow!.edges.filter((edge) => (edge.data as { condition?: unknown })?.condition);
    expect(conditioned.map((edge) => (edge.data as { condition?: unknown }).condition)).toEqual([condition]);
    expect(flowToSpec(compiled.flow!).edges.filter((edge) => edge.condition)).toHaveLength(1);
  });

  it('drops keys a Human step does not know, at every level', () => {
    const compiled = compileFlowSpec(specWith({
      prompt: 'Send it?',
      review: { source: 'last-assistant', script: 'x' },
      fields: [{ name: 'a', type: 'text', onChange: 'x' }],
      surprise: true,
      title: 42,
    }));

    expect(humanNode(compiled).data.properties).toEqual({
      prompt: 'Send it?',
      review: { source: 'last-assistant' },
      fields: [{ name: 'a', type: 'text' }],
    });
  });

  it('never attaches tool servers to a Human step', () => {
    const compiled = compileFlowSpec(specWith({ prompt: 'Send it?', servers: [{ name: 'srv' }] }), { servers: [{ name: 'srv' }] });

    expect(compiled.flow!.nodes.some((node) => node.type === 'mcp')).toBe(false);
    expect(codes(compiled.issues)).toContain('servers-on-unsupported-node');
  });

  it.each([
    ['no question', { mode: 'approval' }, 'human-missing-prompt'],
    ['a question with a bad name', { mode: 'input', prompt: 'Fill in', fields: [{ name: '1 bad', type: 'text' }] }, 'human-invalid-field'],
    ['an unknown question type', { mode: 'input', prompt: 'Fill in', fields: [{ name: 'a', type: 'colour' }] }, 'human-invalid-field'],
    ['a wait of zero minutes', { prompt: 'Send it?', timeoutMinutes: 0 }, 'human-invalid-timeout'],
    ['an unknown choice after a no', { prompt: 'Send it?', onReject: 'maybe' }, 'human-invalid-choice'],
  ])('stops the compile on %s', (_label, step, code) => {
    const compiled = compileFlowSpec(specWith(step));

    expect(compiled.issues).toContainEqual(expect.objectContaining({ severity: 'error', code, nodeKey: 'ask' }));
  });
});

describe('Human step in flow validation', () => {
  const flowOf = (properties: Record<string, unknown>, condition?: Record<string, unknown>) => ({
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start', properties: {} } },
      { id: 'h', type: 'human', position: { x: 0, y: 0 }, data: { label: 'Ask', type: 'human', properties } },
      { id: 'f', type: 'finish', position: { x: 0, y: 0 }, data: { label: 'Finish', type: 'finish', properties: {} } },
      { id: 'p', type: 'process', position: { x: 0, y: 0 }, data: { label: 'Send', type: 'process', properties: { boundModel: 'm', promptTemplate: 'Send ${var:review.value}' } } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'h' },
      { id: 'e2', source: 'h', target: 'p', ...(condition ? { data: { condition } } : {}) },
      { id: 'e3', source: 'h', target: 'f' },
      { id: 'e4', source: 'p', target: 'f' },
    ],
  });
  const issuesOf = (flow: ReturnType<typeof flowOf>) => validateFlow(flow as never).issues;

  it('reports a Human step that cannot ask its question', () => {
    const issues = issuesOf(flowOf({ mode: 'input', fields: [{ name: 'bad name', type: 'text' }], timeoutMinutes: -1 }));

    for (const code of ['human-missing-prompt', 'human-invalid-field', 'human-invalid-timeout']) {
      expect(issues).toContainEqual(expect.objectContaining({ severity: 'error', code, nodeId: 'h' }));
    }
  });

  it('warns when a no or a time-out goes on but no connection checks the answer', () => {
    const continues = issuesOf(flowOf({ prompt: 'Send?', onTimeout: 'continue' }));
    const routed = issuesOf(flowOf(
      { prompt: 'Send?', onReject: 'continue' },
      { kind: 'equals', value: 'approved', target: 'variable', variable: 'review.outcome' },
    ));
    const stops = issuesOf(flowOf({ prompt: 'Send?' }));

    expect(continues).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'human-continue-without-route', nodeId: 'h' }));
    expect(codes(routed)).not.toContain('human-continue-without-route');
    expect(codes(routed)).not.toContain('edge-condition-non-process');
    expect(codes(stops)).not.toContain('human-continue-without-route');
  });

  it('counts the answer as a variable later steps may read', () => {
    expect(codes(issuesOf(flowOf({ prompt: 'Send?' })))).not.toContain('var-ref-uncaptured');
    expect(codes(issuesOf(flowOf({ prompt: 'Send?', outputVariable: 'other' })))).toContain('var-ref-uncaptured');
  });

  it('connects a Human step like any other step, never to tools or data', () => {
    expect(validTargetTypesFor('process', 'process-bottom')).toContain('human');
    expect(validTargetTypesFor('human', 'human-bottom')).toEqual(expect.arrayContaining(['process', 'finish', 'static']));
    expect(getConnectionError('human', 'human-bottom', 'mcp', 'mcp-left')).not.toBeNull();
    expect(getConnectionError('human', 'human-bottom', 'resource', 'resource-in')).not.toBeNull();
  });
});

describe('Human step in a guided simple flow', () => {
  const simple = (step: Record<string, unknown>) => ({
    name: 'review_then_send',
    goal: 'Draft, let a person check, then send',
    model: 'model-1',
    steps: [
      { id: 'draft', task: 'Write the email' },
      { id: 'review', ...step },
      { id: 'send', task: 'Send the email' },
    ],
  });
  const validate = new Ajv({ strict: false }).compile(SIMPLE_FLOW_SPEC_SCHEMA);
  const context = { models: [{ id: 'model-1', name: 'small-model' }] };

  it('accepts a Human step in the schema and still needs a task or a human part', () => {
    expect(validate(simple({ human: { mode: 'edit', prompt: 'Check the email.' } }))).toBe(true);
    expect(validate(simple({ label: 'Review' }))).toBe(false);
    expect(validate(simple({ human: { mode: 'edit', prompt: 'Check', onReject: 'continue' } }))).toBe(false);
    expect(validate(simple({ task: 'Check the email' }))).toBe(true);
  });

  it('lowers a Human step to a human node in the straight line', () => {
    const lowered = lowerSimpleFlowSpec(simple({
      label: 'Check the email',
      human: { mode: 'edit', prompt: 'Check the email.', review: { source: 'last-assistant' }, timeoutMinutes: 60, onReject: 'continue' },
    }) as never);

    expect(lowered.issues).toEqual([]);
    expect(lowered.spec.nodes.map((node) => [node.key, node.type])).toEqual([
      ['__start', 'start'], ['draft', 'process'], ['review', 'human'], ['send', 'process'], ['__finish', 'finish'],
    ]);
    expect(lowered.spec.nodes[2]).toEqual({
      key: 'review',
      type: 'human',
      label: 'Check the email',
      mode: 'edit',
      prompt: 'Check the email.',
      review: { source: 'last-assistant' },
      timeoutMinutes: 60,
    });
    expect(lowered.spec.edges).toEqual([
      { from: '__start', to: 'draft' }, { from: 'draft', to: 'review' }, { from: 'review', to: 'send' }, { from: 'send', to: '__finish' },
    ]);
  });

  it('still refuses a step with neither a task nor a human part', () => {
    const lowered = lowerSimpleFlowSpec(simple({ label: 'Review' }) as never);

    expect(codes(lowered.issues)).toEqual(['simple-step-task-missing']);
  });

  it('reports a broken Human step and compiles a good one into a Guided flow', () => {
    const broken = compileSimpleFlowSpec(simple({ human: { mode: 'input', prompt: 'Fill in' } }) as never, context);
    const good = compileSimpleFlowSpec(simple({ human: { mode: 'approval', prompt: 'Send it?' } }) as never, context);

    expect(broken.issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'human-missing-fields', nodeKey: 'review' }));
    expect(good.errorCount).toBe(0);
    expect(flowUsesAdvancedFeatures(good.flow!)).toBe(false);
  });
});

describe('Human step and the Guided profile', () => {
  const flowWith = (properties: Record<string, unknown>) => ({
    nodes: [{ id: 'h', type: 'human', position: { x: 0, y: 0 }, data: { label: 'Ask', type: 'human', properties } }] as never,
    edges: [],
  });

  it('keeps a Human step that stops on a no or a time-out in Guided mode', () => {
    expect(flowUsesAdvancedFeatures(flowWith({ prompt: 'Send?', mode: 'approval' }))).toBe(false);
    expect(flowUsesAdvancedFeatures(flowWith({ prompt: 'Send?', onReject: 'stop', onTimeout: 'stop' }))).toBe(false);
  });

  it('marks the flow advanced when a no or a time-out goes on', () => {
    expect(flowUsesAdvancedFeatures(flowWith({ prompt: 'Send?', onReject: 'continue' }))).toBe(true);
    expect(flowUsesAdvancedFeatures(flowWith({ prompt: 'Send?', onTimeout: 'continue' }))).toBe(true);
  });
});
