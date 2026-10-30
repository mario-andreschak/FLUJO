import { modelUsage, subflowUsage, whereUsedHref } from '@/utils/shared/whereUsed';

const flows = [
  { id: 'b', name: 'Beta agent', nodes: [
    { data: { type: 'process', properties: { boundModel: 'sonnet' } } },
    { data: { type: 'subflow', properties: { subflowId: 'helper' } } },
  ] },
  { id: 'a', name: 'Alpha agent', nodes: [
    { data: { type: 'process', properties: { boundModel: 'sonnet' } } },
    { data: { type: 'process', properties: { boundModel: 'sonnet' } } },
    { data: { type: 'subflow', properties: { subflowId: 'helper' } } },
    { data: { type: 'subflow', properties: { subflowId: 'a' } } },
  ] },
  { id: 'helper', name: 'Helper', nodes: [{ data: { type: 'process', properties: { boundModel: 'opus' } } }] },
];

describe('where-used (#1278)', () => {
  it('lists each agent once per model, sorted by name, plus fallback policies', () => {
    const usage = modelUsage(flows, [{ id: 'policy', displayName: 'Fast then strong', fallbackPolicy: { modelIds: ['sonnet', 'opus'] } }]);
    expect(usage.sonnet.map(ref => `${ref.kind}:${ref.name}`)).toEqual(['flow:Alpha agent', 'flow:Beta agent', 'policy:Fast then strong']);
    expect(usage.opus.map(ref => ref.name)).toEqual(['Fast then strong', 'Helper']);
    expect(usage.unused).toBeUndefined();
  });

  it('lists the agents that call a flow as a subflow, ignoring self-references', () => {
    const usage = subflowUsage(flows);
    expect(usage.helper.map(ref => ref.name)).toEqual(['Alpha agent', 'Beta agent']);
    expect(usage.a).toBeUndefined();
  });

  it('links an agent to its editor and a policy to the model dialog', () => {
    expect(whereUsedHref({ kind: 'flow', id: 'a b', name: 'x' })).toBe('/flows?flow=a%20b&mode=edit');
    expect(whereUsedHref({ kind: 'policy', id: 'p', name: 'x' })).toBe('/models?edit=p');
  });
});
