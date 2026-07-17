/**
 * Tier 4 — FlowSpec authoring surface for captureKv + `${kv:}` validation.
 *
 * Pins that `captureKv` compiles onto the node properties, round-trips through
 * flowToSpec (so AI-Improve never drops it), and that validation flags a
 * malformed kv key NAME but — unlike `${var:}` — does NOT flag a valid
 * cross-run reference that no step in this flow captures.
 */
import { compileFlowSpec, flowToSpec, type FlowSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';

const context = { models: [{ id: 'm1', name: 'model-one' }] };

const specWith = (captureKv: string): FlowSpec => ({
  name: 'kv_flow',
  nodes: [
    { key: 'start', type: 'start', prompt: 'sys' },
    { key: 'p', type: 'process', model: 'm1', prompt: 'do it', captureKv },
    { key: 'end', type: 'finish' },
  ],
  edges: [
    { from: 'start', to: 'p' },
    { from: 'p', to: 'end' },
  ],
});

describe('FlowSpec captureKv compile + round-trip', () => {
  it('compiles captureKv onto the process node properties', () => {
    const { flow } = compileFlowSpec(specWith('counter'), context);
    const p = flow!.nodes.find((n) => n.data?.properties?.captureKv);
    expect(p?.data?.properties?.captureKv).toBe('counter');
  });

  it('round-trips a scope-prefixed captureKv through flowToSpec', () => {
    const { flow } = compileFlowSpec(specWith('flow/cursor'), context);
    const spec = flowToSpec(flow!);
    const p = spec.nodes.find((n) => n.type === 'process');
    expect(p?.captureKv).toBe('flow/cursor');
  });
});

describe('validateFlow kv checks', () => {
  const baseNodes = (props: Record<string, unknown>) => [
    { id: 'start', data: { type: 'start', properties: {} } },
    { id: 'p', data: { type: 'process', properties: { boundModel: 'm1', ...props } } },
    { id: 'end', data: { type: 'finish', properties: {} } },
  ];
  const edges = [
    { source: 'start', target: 'p' },
    { source: 'p', target: 'end' },
  ];
  const run = (props: Record<string, unknown>) =>
    validateFlow({ nodes: baseNodes(props) as any, edges }, { models: [{ id: 'm1' }] });

  it('warns on an invalid captureKv key name', () => {
    expect(run({ captureKv: '9bad' }).issues.some((i) => i.code === 'capture-kv-name')).toBe(true);
  });

  it('accepts a valid captureKv even though nothing references it', () => {
    expect(run({ captureKv: 'good_name' }).issues.some((i) => i.code === 'capture-kv-name')).toBe(false);
  });

  it('warns on a malformed ${kv:} reference key', () => {
    expect(run({ promptTemplate: 'x ${kv:9bad}' }).issues.some((i) => i.code === 'kv-ref-name')).toBe(true);
  });

  it('does NOT warn on a valid ${kv:} reference nothing captures (cross-run)', () => {
    expect(run({ promptTemplate: 'x ${kv:seeded}' }).issues.some((i) => i.code === 'kv-ref-name')).toBe(false);
  });
});
