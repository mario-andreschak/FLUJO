import { flowUsesAdvancedFeatures } from '@/utils/shared/flowAuthoringProfile';

const node = (type: string, properties: Record<string, unknown> = {}) => ({
  id: type,
  type,
  position: { x: 0, y: 0 },
  data: { label: type, type, properties },
});

describe('flowUsesAdvancedFeatures', () => {
  it('keeps the common guided graph in Guided mode', () => {
    expect(flowUsesAdvancedFeatures({
      nodes: [
        node('start'),
        node('process', {
          boundModel: 'm1',
          promptTemplate: 'work',
          inputMode: 'full-history',
          outputMode: 'latest-message',
        }),
        node('subflow', {
          subflowId: 'child',
          inputMode: 'full-history',
          outputMode: 'final-only',
          resultPresentation: 'separate',
          sessionScope: 'per-key',
        }),
        node('finish'),
      ] as never,
      edges: [],
    })).toBe(false);
  });

  it('ignores a historical unattended flag when deciding authoring mode', () => {
    expect(flowUsesAdvancedFeatures({
      nodes: [node('start'), node('process'), node('finish')],
      edges: [],
      unattended: true,
    } as never)).toBe(false);
  });

  it('keeps visible Persona abilities available in Guided mode', () => {
    expect(flowUsesAdvancedFeatures({
      nodes: [node('process', { personaTools: ['recall', 'work_item_create'] })],
      edges: [],
    } as never)).toBe(false);
  });

  it('keeps canonical Process/Subflow subagent connections in Guided mode', () => {
    expect(flowUsesAdvancedFeatures({
      nodes: [
        node('process', { inputMode: 'full-history', outputMode: 'latest-message' }),
        {
          ...node('subflow', {
            subflowId: 'helper-flow',
            inputMode: 'isolated',
            outputMode: 'final-only',
            resultPresentation: 'separate',
            sessionScope: 'per-key',
          }),
          id: 'helper-node',
        },
      ] as never,
      edges: [{
        id: 'call-helper',
        source: 'process',
        target: 'helper-node',
        data: { edgeType: 'standard', bidirectional: true },
      }] as never,
    })).toBe(false);
  });

  it('still treats non-canonical bidirectional subflows as advanced', () => {
    expect(flowUsesAdvancedFeatures({
      nodes: [
        node('process'),
        { ...node('subflow', { subflowId: 'helper-flow' }), id: 'helper-node' },
      ] as never,
      edges: [{
        id: 'call-helper',
        source: 'process',
        target: 'helper-node',
        data: { edgeType: 'standard', bidirectional: true },
      }] as never,
    })).toBe(true);
  });

  it.each([
    ['resource node', { nodes: [node('resource')], edges: [] }],
    ['process capture', { nodes: [node('process', { captureVariable: 'result' })], edges: [] }],
    ['subflow fanout', { nodes: [node('subflow', { allowCallerFanout: true })], edges: [] }],
    ['conditional edge', { nodes: [], edges: [{ data: { condition: { kind: 'always' } } }] }],
  ])('detects %s as advanced', (_label, flow) => {
    expect(flowUsesAdvancedFeatures(flow as never)).toBe(true);
  });

  it.each([
    ['joined result presentation', { resultPresentation: 'joined' }],
    ['fresh-per-visit sessions', { sessionScope: 'per-visit' }],
    ['one session per parent run', { sessionScope: 'per-run' }],
  ])('keeps explicit %s in Advanced mode', (_label, properties) => {
    expect(flowUsesAdvancedFeatures({
      nodes: [node('subflow', properties)],
      edges: [],
    } as never)).toBe(true);
  });
});
