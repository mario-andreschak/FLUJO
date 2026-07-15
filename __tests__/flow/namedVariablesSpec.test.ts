/**
 * Tier 2c — FlowSpec compiler + validation for named variables.
 *
 * Compiler: `captureVariable` is copied onto process AND subflow node properties
 *   and round-trips through flowToSpec. `${var:NAME}` needs no DSL field (it is
 *   plain prompt text resolved at runtime), so it must simply survive compilation.
 * Validation (advisory, never blocking): an invalid captureVariable name warns; a
 *   `${var:NAME}` reference nothing captures warns; a captured reference does not.
 */
import { compileFlowSpec, flowToSpec, type FlowSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';

const MODELS = [{ id: 'm1', name: 'gpt', displayName: 'GPT' }];

describe('compileFlowSpec — captureVariable', () => {
  it('copies captureVariable onto a process node and keeps ${var:} prompt text verbatim', () => {
    const spec: FlowSpec = {
      name: 'vars',
      nodes: [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'p1', type: 'process', model: 'm1', prompt: 'produce a plan', captureVariable: 'plan' },
        { key: 'p2', type: 'process', model: 'm1', prompt: 'execute ${var:plan}' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p1' },
        { from: 'p1', to: 'p2' },
        { from: 'p2', to: 'f' },
      ],
    };
    const { flow, errorCount } = compileFlowSpec(spec, { models: MODELS });
    expect(errorCount).toBe(0);
    const p1 = flow!.nodes.find((n) => n.data.label && (n.data.properties as any)?.captureVariable);
    expect((p1!.data.properties as any).captureVariable).toBe('plan');
    // The ${var:} reference is left in the prompt untouched (resolved at runtime).
    const p2 = flow!.nodes.find((n) => (n.data.properties as any)?.promptTemplate === 'execute ${var:plan}');
    expect(p2).toBeTruthy();
  });

  it('copies captureVariable onto a subflow node', () => {
    const spec: FlowSpec = {
      name: 'subvars',
      nodes: [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'sub', type: 'subflow', flow: 'child', captureVariable: 'childOut' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'sub' },
        { from: 'sub', to: 'f' },
      ],
    };
    const { flow } = compileFlowSpec(spec, { models: MODELS, flows: [{ id: 'child', name: 'child' }] });
    const sub = flow!.nodes.find((n) => n.type === 'subflow');
    expect((sub!.data.properties as any).captureVariable).toBe('childOut');
  });

  it('trims a captureVariable and drops an empty one', () => {
    const spec: FlowSpec = {
      name: 'trim',
      nodes: [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'p1', type: 'process', model: 'm1', prompt: 'x', captureVariable: '  spaced  ' },
        { key: 'p2', type: 'process', model: 'm1', prompt: 'y', captureVariable: '   ' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p1' },
        { from: 'p1', to: 'p2' },
        { from: 'p2', to: 'f' },
      ],
    };
    const { flow } = compileFlowSpec(spec, { models: MODELS });
    const props = flow!.nodes.filter((n) => n.type === 'process').map((n) => (n.data.properties as any).captureVariable);
    expect(props).toContain('spaced'); // trimmed
    expect(props).toContain(undefined); // empty dropped
  });

  it('round-trips captureVariable through flowToSpec (process + subflow)', () => {
    const spec: FlowSpec = {
      name: 'rt',
      nodes: [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'p1', type: 'process', model: 'm1', prompt: 'x', captureVariable: 'plan' },
        { key: 'sub', type: 'subflow', flow: 'child', captureVariable: 'childOut' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p1' },
        { from: 'p1', to: 'sub' },
        { from: 'sub', to: 'f' },
      ],
    };
    const { flow } = compileFlowSpec(spec, { models: MODELS, flows: [{ id: 'child', name: 'child' }] });
    const back = flowToSpec(flow!);
    const p1 = back.nodes.find((n) => n.type === 'process');
    const sub = back.nodes.find((n) => n.type === 'subflow');
    expect(p1!.captureVariable).toBe('plan');
    expect(sub!.captureVariable).toBe('childOut');
  });
});

describe('validateFlow — named variable advisories (never blocking)', () => {
  const base = (extra: Partial<{ p1props: any; p2props: any }> = {}) => ({
    id: 'f',
    name: 'f',
    nodes: [
      { id: 's', type: 'start', data: { type: 'start', label: 'Start', properties: {} } },
      { id: 'p1', type: 'process', data: { type: 'process', label: 'Planner', properties: { boundModel: 'm1', ...extra.p1props } } },
      { id: 'p2', type: 'process', data: { type: 'process', label: 'Worker', properties: { boundModel: 'm1', ...extra.p2props } } },
      { id: 'f', type: 'finish', data: { type: 'finish', label: 'Finish', properties: {} } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'p1', data: { edgeType: 'standard' } },
      { id: 'e2', source: 'p1', target: 'p2', data: { edgeType: 'standard' } },
      { id: 'e3', source: 'p2', target: 'f', data: { edgeType: 'standard' } },
    ],
  });

  it('a captured reference produces NO var warning', () => {
    const flow = base({ p1props: { captureVariable: 'plan' }, p2props: { promptTemplate: 'do ${var:plan}' } });
    const result = validateFlow(flow as any, { models: MODELS });
    expect(result.issues.find((i) => i.code === 'var-ref-uncaptured')).toBeUndefined();
    expect(result.errorCount).toBe(0);
  });

  it('an uncaptured reference warns (var-ref-uncaptured) but never blocks', () => {
    const flow = base({ p2props: { promptTemplate: 'do ${var:missing}' } });
    const result = validateFlow(flow as any, { models: MODELS });
    const warn = result.issues.find((i) => i.code === 'var-ref-uncaptured');
    expect(warn?.severity).toBe('warning');
    expect(warn?.nodeId).toBe('p2');
    expect(result.isRunnable).toBe(true); // advisory only
  });

  it('also scans isolatedPrompt for references', () => {
    const flow = base({ p2props: { inputMode: 'isolated', isolatedPrompt: 'use ${var:ghost}' } });
    const result = validateFlow(flow as any, { models: MODELS });
    expect(result.issues.find((i) => i.code === 'var-ref-uncaptured')).toBeTruthy();
  });

  it('an invalid captureVariable name warns (capture-var-name) but never blocks', () => {
    const flow = base({ p1props: { captureVariable: '2 bad name' } });
    const result = validateFlow(flow as any, { models: MODELS });
    const warn = result.issues.find((i) => i.code === 'capture-var-name');
    expect(warn?.severity).toBe('warning');
    expect(result.isRunnable).toBe(true);
  });

  it('a var seeded from run input (nothing captures it) still warns — author should double-check', () => {
    // We cannot know about FlowRunInput.variables at author time, so this is a
    // best-effort typo/ordering hint, not proof of breakage. It stays a warning.
    const flow = base({ p1props: { promptTemplate: 'start with ${var:seeded}' } });
    const result = validateFlow(flow as any, { models: MODELS });
    expect(result.issues.find((i) => i.code === 'var-ref-uncaptured')).toBeTruthy();
    expect(result.isRunnable).toBe(true);
  });
});
