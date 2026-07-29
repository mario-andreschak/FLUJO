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
        }),
        node('finish'),
      ] as never,
      edges: [],
    })).toBe(false);
  });

  it.each([
    ['resource node', { nodes: [node('resource')], edges: [] }],
    ['process capture', { nodes: [node('process', { captureVariable: 'result' })], edges: [] }],
    ['subflow fanout', { nodes: [node('subflow', { allowCallerFanout: true })], edges: [] }],
    ['conditional edge', { nodes: [], edges: [{ data: { condition: { kind: 'always' } } }] }],
    ['permissions', { nodes: [], edges: [], permissionRules: [] }],
  ])('detects %s as advanced', (_label, flow) => {
    expect(flowUsesAdvancedFeatures(flow as never)).toBe(true);
  });
});
